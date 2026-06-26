/**
 * Gemini Transparent Proxy — Cloudflare Workers Edition (Ultra-Compatible Version)
 * 
 * 修复重点：
 * 1. 彻底解决 QClaw 400 错误：实现“错误 SSE 包装”。如果客户端请求 stream=true 但上游返回 400，将错误信息包装成 SSE 格式返回，避免客户端解析崩溃。
 * 2. 增强稳定性：引入 Body 白名单机制，剔除所有可能引起 Google API 400 报错的冗余字段。
 * 3. 保持 Real-time Stream: TransformStream 实时转发响应，保留 <thought> 标签供客户端识别。
 */

// Google Gemini OpenAI-compatible API 不支持的字段黑名单（黑名单 vs 白名单：只删明确不支持的字段，其他全部透传）
const GOOGLE_OPENAI_BLOCKED = new Set([
  'stream_options',          // Google API 不认识
  'reasoning_effort',        // OpenAI 推理强度
  'frequency_penalty',       // Google 不支持
  'presence_penalty',        // Google 不支持
  'logit_bias',              // Google 不支持
  'logprobs',                // Google 不支持
  'top_logprobs',            // Google 不支持
  'seed',                    // Google 不支持
  'user',                    // Google 不支持
  'service_tier',            // OpenAI 专用
  'n',                       // Google 用 candidate_count 代替
  'include_reasoning',       // 部分客户端会发
  'store',                   // OpenAI 会发 store:false，Google 不认识
  'metadata',                // OpenAI 偶尔会发
  'parallel_tool_calls',     // Google 不支持此字段
  'response_format',         // OpenAI 结构化输出（Google 可能不兼容）
]);

const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authorization',
  'proxy-authenticate', 'te', 'trailers', 'transfer-encoding',
  'upgrade', 'content-length',
]);

const RESPONSE_BLOCKED = new Set([
  'content-encoding', 'transfer-encoding', 'connection',
  'keep-alive', 'strict-transport-security',
]);

const MODELS = {
  object: 'list',
  data: [
    { id: 'gemma-4-31b-it', object: 'model', created: 1743561600, owned_by: 'google' },
    { id: 'gemma-4-26b-a4b-it', object: 'model', created: 1743561600, owned_by: 'google' },
  ],
};

function generateReqId() {
  return Date.now().toString(16).slice(-6) + Math.random().toString(16).slice(2, 6);
}

/** 黑名单过滤：仅删除 Google 明确不支持的字段，其他全部透传 */
function sanitizeOpenAIBodyStrict(body) {
  if (!body) return body;
  try {
    const json = JSON.parse(body);
    const cleaned = {};
    for (const key in json) {
      if (!GOOGLE_OPENAI_BLOCKED.has(key) && json[key] !== null) {
        cleaned[key] = json[key];
      }
    }
    return JSON.stringify(cleaned);
  } catch {
    return body;
  }
}

function buildTargetUrl(pathname, queryString) {
  const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';
  let targetPath = pathname;
  if (pathname.startsWith('/api/v1/')) {
    targetPath = '/v1beta/openai/' + pathname.slice('/api/v1/'.length);
  } else if (pathname.startsWith('/v1/')) {
    targetPath = '/v1beta/openai/' + pathname.slice('/v1/'.length);
  }
  return `${GOOGLE_API_BASE}${targetPath}${queryString || ''}`;
}

function cleanHeaders(requestHeaders) {
  const headers = new Headers();
  for (const [key, value] of requestHeaders.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  return headers;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
  };
}

function buildResponseHeaders(response) {
  const headers = new Headers();
  for (const [key, value] of response.headers.entries()) {
    if (!RESPONSE_BLOCKED.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  const cors = corsHeaders();
  for (const [k, v] of Object.entries(cors)) {
    headers.set(k, v);
  }
  return headers;
}

const RETRYABLE = new Set([502, 503]);
const RETRY_TIMEOUT = 25000;

// 内存滑动窗口限流器（每个 Worker 实例独立计数，CF 的多实例间不共享）
// 限制：每分钟每 IP 最多 60 次请求，覆盖常见用量但防止刷爆
class RateLimiter {
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.requests = new Map();
  }

  check(key) {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let timestamps = this.requests.get(key) || [];
    // 清除窗口外的旧记录
    timestamps = timestamps.filter(t => t > windowStart);

    if (timestamps.length >= this.maxRequests) {
      return false;
    }

    timestamps.push(now);
    this.requests.set(key, timestamps);
    return true;
  }

  // 清理过期条目，防止内存泄漏
  cleanup() {
    const windowStart = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.requests.entries()) {
      const filtered = timestamps.filter(t => t > windowStart);
      if (filtered.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, filtered);
      }
    }
  }
}

const rateLimiter = new RateLimiter(60 * 1000, 60);

// 请求日志
function logRequest(reqId, method, pathname, status, durationMs, extra = '') {
  console.log(`[${reqId}] ${method} ${pathname} → ${status} (${durationMs}ms)${extra ? ' ' + extra : ''}`);
}

// IPv6 地址归一化：展开压缩形式，避免同一网络的 IPv6 前缀被识别为不同 IP
function normalizeIP(ip) {
  if (!ip || ip === 'unknown') return ip;
  if (ip.includes(':')) {
    try {
      const clean = ip.split('%')[0]; // 去掉 zone-id（eth0 等）
      if (clean.includes('::')) {
        const parts = clean.split(':');
        const emptyIdx = parts.indexOf('');
        const nonEmptyBeforeEmpty = parts.slice(0, emptyIdx).filter(p => p !== '').length;
        const nonEmptyAfterEmpty = parts.slice(emptyIdx + 1).filter(p => p !== '').length;
        const left = parts.slice(0, emptyIdx).filter(p => p !== '');
        const right = parts.slice(emptyIdx + 1).filter(p => p !== '');
        const midCount = 8 - nonEmptyBeforeEmpty - nonEmptyAfterEmpty;
        return [].concat(left, Array(midCount).fill('0'), right).map(p => p.padStart(4, '0')).join(':');
      }
      return clean.split(':').map(p => p.padStart(4, '0')).join(':');
    } catch {
      return ip;
    }
  }
  return ip; // IPv4 保持原样
}

async function fetchWithRetry(url, options, startTime, maxAttempts = 2) {
  let lastError;
  let retries = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, options);
      if (RETRYABLE.has(response.status) && attempt < maxAttempts) {
        const elapsed = Date.now() - startTime;
        if (elapsed > RETRY_TIMEOUT) {
          response.retries = retries;
          return response;
        }
        retries++;
        await new Promise((r) => setTimeout(r, attempt * 500));
        continue;
      }
      response.retries = retries;
      return response;
    } catch (error) {
      lastError = error;
      retries++;
      const elapsed = Date.now() - startTime;
      if (attempt < maxAttempts && elapsed < RETRY_TIMEOUT) {
        await new Promise((r) => setTimeout(r, attempt * 500));
      } else {
        break;
      }
    }
  }
  throw lastError || new Error('Max retry attempts reached');
}

/** 模型降级链：Google 503 high demand 时自动尝试更小模型 */
const MODEL_FALLBACKS = {
  'gemma-4-31b-it': 'gemma-4-26b-a4b-it',
  'gemma-4-26b-a4b-it': 'gemini-2.5-flash',
};

/** 检测 Google 503 UNAVAILABLE 错误体 */
function isHighDemand503(bodyText) {
  return bodyText.includes('UNAVAILABLE') || bodyText.includes('high demand');
}

// 获取配额日期（YYYYMMDD，15 小时偏移与 Vercel 端对齐）
function getQuotaDate() {
  const now = new Date();
  const offsetDate = new Date(now.getTime() - 15 * 60 * 60 * 1000);
  return offsetDate.toISOString().split('T')[0];
}

// Upstash Redis REST：逐条发送，不报错
// 注意：Upstash REST API 不识别 pipeline 格式 [['INCR','k1'],['INCR','k2']]，
// 必须逐条发送单条命令 ['INCR', 'key'] — 但可以并行发起多个请求
async function upstashPipe(env, commands) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return;
  await Promise.all(commands.map(cmd => {
    return fetch(env.UPSTASH_REDIS_REST_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cmd),
    }).catch(() => {});
  }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, search } = url;
    const startTime = Date.now();
    // 清理过期限流条目（轻量操作，每个请求执行一次）
    ctx.waitUntil(Promise.resolve(rateLimiter.cleanup()));
    const reqId = generateReqId();

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 调试端点：返回环境变量状态（不暴露值）
    if (pathname.endsWith('/v1/env') || pathname.endsWith('/env')) {
      return new Response(JSON.stringify({
        UPSTASH_REDIS_REST_URL: !!env.UPSTASH_REDIS_REST_URL,
        UPSTASH_REDIS_REST_TOKEN: !!env.UPSTASH_REDIS_REST_TOKEN,
        NODE_ENV: env.NODE_ENV || 'not set',
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }


    if (pathname.endsWith('/models') || pathname.includes('/v1/models') || pathname.includes('/v1beta/openai/models')) {
      return new Response(JSON.stringify(MODELS), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    // 限流检查（基于客户端 IP）
    const rawIP = (request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
    const clientIP = normalizeIP(rawIP);
    if (!rateLimiter.check(clientIP)) {
      logRequest(reqId, request.method, pathname, 429, Date.now() - startTime, `rate-limited ${clientIP}`);
      return new Response(JSON.stringify({
        error: {
          message: '请求过于频繁，请稍后重试',
          type: 'rate_limit_error',
          code: 429,
          reqId
        }
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
          'X-Request-Id': reqId,
          ...corsHeaders(),
        }
      });
    }

    try {
      let targetUrl = buildTargetUrl(pathname, search);
      const isOpenAICompat = targetUrl.includes('/v1beta/openai/');
      const authHeader = request.headers.get('authorization') || '';
      let apiKey = '';
      if (authHeader.startsWith('Bearer ')) {
        apiKey = authHeader.slice(7).trim();
      }

      const headers = cleanHeaders(request.headers);
      if (apiKey) {
        if (!isOpenAICompat) {
          const urlWithKey = new URL(targetUrl);
          urlWithKey.searchParams.set('key', apiKey);
          targetUrl = urlWithKey.toString();
          headers.delete('authorization');
        }
      }

      let body = null;
      let originalStreamRequested = false;
      let requestBodyText = null; // 保存原始请求体，供模型降级用
      let modelId = 'unknown'; // 用于遥测的模型 ID
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        try {
          const text = await request.text();
          requestBodyText = text;
          body = text && text.trim() !== '' ? text : '{}';
          
          if (isOpenAICompat) {
            const parsed = JSON.parse(body);
            if (parsed.stream === true) originalStreamRequested = true;
            if (parsed.model) modelId = parsed.model;
            body = sanitizeOpenAIBodyStrict(body);
          }
        } catch {
          body = '{}';
        }
      }

      let response = await fetchWithRetry(targetUrl, {
        method: request.method,
        headers,
        body,
        cache: 'no-store',
      }, startTime);

      // === 模型降级：Google 503 high demand / 524 源站超时 → 自动切换更小模型 ===
      if ((response.status === 503 || response.status === 524) && isOpenAICompat && requestBodyText) {
        if (response.status === 524 || isHighDemand503(await response.text())) {
          const originalModel = JSON.parse(requestBodyText).model;
          const fallbackModel = originalModel ? MODEL_FALLBACKS[originalModel] : null;
          if (fallbackModel) {
            const newBody = JSON.parse(body);
            newBody.model = fallbackModel;
            const fallbackResp = await fetchWithRetry(targetUrl, {
              method: request.method,
              headers,
              body: JSON.stringify(newBody),
              cache: 'no-store',
            }, startTime);
            logRequest(reqId, request.method, pathname, fallbackResp.status, Date.now() - startTime,
              `fallback ${originalModel} → ${fallbackModel}`);
            if (fallbackResp.status !== 503 && fallbackResp.status !== 524) {
              response = fallbackResp;
              modelId = fallbackModel;
            } else {
              // 降级也失败，重建原响应
              const origHeaders = buildResponseHeaders(response);
              response = new Response('', { status: response.status, statusText: response.statusText, headers: origHeaders });
            }
          }
        }
      }

      // Upstash 遥测（fire-and-forget）：写同样的 key，数据与 Vercel 端打通
      // 写入：status + timeline（always）+ quota（仅成功，含 global + per-model）
      //       + recent + errors（仅 status >= 400）
      const date = getQuotaDate();
      const bjHour = (new Date().getUTCHours() + 8) % 24;
      const isSuccess = response.status < 400;
      const finalModelId = modelId === 'unknown' ? 'unknown-model' : modelId;
      const nowMs = Date.now();
      const latency = nowMs - startTime;
      const ua = request.headers.get('user-agent') || 'unknown';
      const telemetryCmds = [
        ['INCR', `status:${date}:${response.status}`],
        ['INCR', `timeline:${date}:h${bjHour}`],
        // 最近请求列表（LPUSH + LTRIM 保留最新 30 条）
        ['LPUSH', `recent:${date}`, JSON.stringify({
          ts: new Date().toISOString(),
          status: response.status,
          model: finalModelId,
          latency,
          ua,
          ip: clientIP,
        })],
        ['LTRIM', `recent:${date}`, 0, 29],
      ];
      // 错误日志（仅 status >= 400，保留最新 20 条）
      if (response.status >= 400) {
        telemetryCmds.push(
          ['LPUSH', `errors:${date}`, JSON.stringify({
            ts: new Date().toISOString(),
            status: response.status,
            model: finalModelId,
            latency,
            message: `${response.status} ${response.statusText}`,
            ua,
            ip: clientIP,
          })],
          ['LTRIM', `errors:${date}`, 0, 19],
        );
      }
      if (isSuccess) {
        telemetryCmds.push(
          ['INCR', `quota:${date}:${finalModelId}`],
          ['INCR', `quota:global:${date}`],
        );
      }
      ctx.waitUntil(upstashPipe(env, telemetryCmds));

      const respHeaders = buildResponseHeaders(response);
      respHeaders.set('X-Request-Id', reqId);
      respHeaders.set('X-Proxy', 'cloudflare-workers');

      const upstreamBody = response.body;
      const contentType = response.headers.get('content-type') || '';

      // --- 情况 1: 正常流式响应 ---
      if (upstreamBody && (contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson'))) {
        // 确保 SSE 响应头完整
        if (!respHeaders.has('Cache-Control') || respHeaders.get('Cache-Control') === 'no-store') {
          respHeaders.set('Cache-Control', 'no-cache');
        }
        respHeaders.set('X-Accel-Buffering', 'no');
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const reader = upstreamBody.getReader();
        let aborted = false;
        let thoughtBuffer = '';
        let inThought = false;

        const streamPromise = (async () => {
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          let leftover = '';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done || aborted) break;

              let chunk = decoder.decode(value, { stream: true });
              leftover += chunk;
              const lines = leftover.split('\n');
              leftover = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('data: ') && !line.startsWith('data: [DONE]')) {
                  try {
                    const jsonStr = line.slice(6);
                    const parsed = JSON.parse(jsonStr);
                    // 从 content 剥离 <thought> 标签，迁移到标准的 reasoning_content 字段
                    // qclaw/workbuddy 等客户端通过 delta.reasoning_content 识别思考过程
                    // 处理跨 SSE 事件的 <thought> 标签：可能被 Google 分成多个 delta
                    if (parsed.choices && Array.isArray(parsed.choices)) {
                      for (const choice of parsed.choices) {
                        if (choice.delta) {
                          if (typeof choice.delta.content === 'string') {
                            let raw = choice.delta.content;
                            let reasoning = '';
                            let content = '';

                            if (inThought) {
                              const endIdx = raw.indexOf('</thought>');
                              if (endIdx >= 0) {
                                thoughtBuffer += raw.slice(0, endIdx);
                                reasoning = thoughtBuffer;
                                thoughtBuffer = '';
                                inThought = false;
                                const after = raw.slice(endIdx + '</thought>'.length);
                                if (after) content = after;
                              } else {
                                thoughtBuffer += raw;
                              }
                            } else {
                              const startIdx = raw.indexOf('<thought>');
                              if (startIdx >= 0) {
                                content = raw.slice(0, startIdx);
                                const afterTag = raw.slice(startIdx + '<thought>'.length);
                                const endIdx = afterTag.indexOf('</thought>');
                                if (endIdx >= 0) {
                                  reasoning = afterTag.slice(0, endIdx);
                                  const after = afterTag.slice(endIdx + '</thought>'.length);
                                  if (after) content += after;
                                } else {
                                  inThought = true;
                                  thoughtBuffer = afterTag;
                                }
                              } else {
                                content = raw;
                              }
                            }

                            choice.delta.content = content;
                            if (reasoning) {
                              if (choice.delta.reasoning_content) {
                                choice.delta.reasoning_content += reasoning;
                              } else {
                                choice.delta.reasoning_content = reasoning;
                              }
                            }
                          }
                        }
                      }
                    }
                    const hasContent = parsed.choices?.some(c => c.delta?.content !== undefined || c.delta?.reasoning_content !== undefined);
                    // ⚠️ finish_reason 在 choice 层，不在 choice.delta 里！
                    // 如果检查 c.delta?.finish_reason 会永远返回 undefined，
                    // 导致最后一条 SSE 事件被静默丢弃→流结束无 finish_reason→Hermes 报"empty stream"
                    const hasFinish = parsed.choices?.some(c => c.finish_reason !== undefined);
                    if (hasContent || hasFinish) {
                      await writer.write(encoder.encode('data: ' + JSON.stringify(parsed) + '\n'));
                    }
                  } catch {
                    await writer.write(encoder.encode(line + '\n'));
                  }
                } else {
                  await writer.write(encoder.encode(line + '\n'));
                }
              }
            }
          } catch (err) {
            console.error(`[${reqId}] Stream error: ${err.message}`);
            // 刷新残留的 leftover 数据，避免半截线丢失
            if (leftover) {
              try { await writer.write(encoder.encode(leftover + '\n')); } catch {}
            }
            // 流被中断，发一条合成 finish_reason 事件
            // 避免 Hermes 看到流结束但没有 finish_reason → "empty stream"
            try {
              await writer.write(encoder.encode('data: ' + JSON.stringify({
                choices: [{ delta: {}, finish_reason: 'stop', index: 0 }]
              }) + '\n'));
            } catch {}
          } finally {
            await writer.close();
            reader.cancel().catch(() => {});
          }
        })();
        // ⚠️ ctx.waitUntil 返回 void！不能链式 .catch()，必须先保存 promise 变量
        streamPromise.catch(err => console.error(`[${reqId}] ctx.waitUntil error: ${err.message}`));
        ctx.waitUntil(streamPromise);

        request.signal.addEventListener('abort', () => {
          aborted = true;
          reader.cancel().catch(() => {});
          writer.close().catch(() => {});
        }, { once: true });

        logRequest(reqId, request.method, pathname, response.status, Date.now() - startTime, 'stream');
        return new Response(readable, {
          status: response.status,
          statusText: response.statusText,
          headers: respHeaders,
        });
      }

      // --- 情况 2: 错误响应且客户端请求了流式 ---
      // 关键修复：如果上游返回 4xx/5xx 但客户端在等 SSE 流，
      // 我们必须将错误包装在 'data: ' 中返回，否则客户端解析器会因为看到 JSON 而报错 "no body"
      if (response.status >= 400 && originalStreamRequested) {
        const errorMsg = await response.text().catch(() => 'No error body');
        const sseError = `data: ${JSON.stringify({
          error: { message: `Upstream Error ${response.status}: ${errorMsg}`, type: 'upstream_error', code: response.status, reqId }
        })}\n\n`;
        
        const sseHeaders = new Headers(respHeaders);
        sseHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
        sseHeaders.set('Cache-Control', 'no-cache');
        sseHeaders.set('Connection', 'keep-alive');

        logRequest(reqId, request.method, pathname, response.status, Date.now() - startTime, 'error-sse');
        return new Response(sseError, {
          status: response.status,
          statusText: response.statusText,
          headers: sseHeaders,
        });
      }

      // --- 情况 3: 普通非流式响应 ---
      let finalBody = upstreamBody || null;
      if (!finalBody && response.status >= 400) {
        finalBody = JSON.stringify({
          error: { message: `Upstream returned HTTP ${response.status}`, type: 'upstream_error', code: response.status, reqId },
        });
        respHeaders.set('Content-Type', 'application/json');
      }

      logRequest(reqId, request.method, pathname, response.status, Date.now() - startTime);
      return new Response(finalBody, {
        status: response.status,
        statusText: response.statusText,
        headers: respHeaders,
      });
    } catch (error) {
      logRequest(reqId, request.method, pathname, 502, Date.now() - startTime, error.message);
      // 也写遥测，让 Dashboard 看到代理错误
      const errDate = getQuotaDate();
      const errHour = (new Date().getUTCHours() + 8) % 24;
      ctx.waitUntil(upstashPipe(env, [
        ['INCR', `status:${errDate}:502`],
        ['INCR', `timeline:${errDate}:h${errHour}`],
        ['LPUSH', `errors:${errDate}`, JSON.stringify({
          ts: new Date().toISOString(),
          status: 502,
          model: 'proxy-error',
          latency: Date.now() - startTime,
          message: error.message,
          ua: request.headers.get('user-agent') || 'unknown',
          ip: clientIP,
        })],
        ['LTRIM', `errors:${errDate}`, 0, 19],
      ]));
      return new Response(
        JSON.stringify({ error: { message: '代理请求失败', type: 'proxy_error', code: 502, reqId } }),
        { status: 502, headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId, ...corsHeaders() } }
      );
    }
  },
};
