/**
 * Gemini Transparent Proxy — Cloudflare Workers Edition
 *
 * 与 Vercel 版保持相同逻辑，利用 CF Workers 无超时优势（等待外部 API 的时间不计入 CPU 配额）
 *
 * 部署:
 *   npm install -g wrangler
 *   wrangler login
 *   cd cloudflare-worker && wrangler deploy
 *
 * 使用: https://gemini-proxy.你的子域名.workers.dev/v1/chat/completions
 *
 * QClaw 配置:
 *   baseUrl: https://gemini-proxy.你的子域名.workers.dev
 *   apiKey: 你的-Google-API-Key
 *   api: openai-completions
 */

// ============================================================
// Google Gemini OpenAI-compatible API 不支持的字段黑名单
// ============================================================
const GOOGLE_OPENAI_BLOCKED = new Set([
  'stream_options',      // Google API 不认识
  'reasoning_effort',    // OpenAI 推理强度
  'frequency_penalty',   // Google 不支持
  'presence_penalty',    // Google 不支持
  'logit_bias',          // Google 不支持
  'logprobs',            // Google 不支持
  'top_logprobs',        // Google 不支持
  'seed',                // Google 不支持
  'user',                // Google 不支持
  'service_tier',        // OpenAI 专用
  'n',                   // Google 用 candidate_count 代替
  'include_reasoning',   // 部分客户端会发
]);

// ============================================================
// Hop-by-hop headers — 不转发给上游
// ============================================================
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authorization',
  'proxy-authenticate', 'te', 'trailers', 'transfer-encoding',
  'upgrade', 'content-length',
]);

// ============================================================
// 响应头 blocklist — 不输出给客户端
// ============================================================
const RESPONSE_BLOCKED = new Set([
  'content-encoding', 'transfer-encoding', 'connection',
  'keep-alive', 'strict-transport-security',
]);

// ============================================================
// 模型列表
// ============================================================
const MODELS = {
  object: 'list',
  data: [
    {
      id: 'gemma-4-31b-it',
      object: 'model',
      created: 1743561600,
      owned_by: 'google',
    },
    {
      id: 'gemma-4-26b-a4b-it',
      object: 'model',
      created: 1743561600,
      owned_by: 'google',
    },
  ],
};

// ============================================================
// 工具函数
// ============================================================

/** 生成请求追踪 ID */
function generateReqId() {
  return (
    Date.now().toString(16).slice(-6) +
    Math.random().toString(16).slice(2, 6)
  );
}

/** 过滤 OpenAI 独有参数，避免 Google API 报 400 */
function sanitizeOpenAIBody(body) {
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
    return body; // 非 JSON 透传
  }
}

/** 路径重写: /api/v1/... or /v1/... → /v1beta/openai/... */
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

/** 清理转发请求头，移除不可转发的字段 */
function cleanHeaders(requestHeaders) {
  const headers = new Headers();
  for (const [key, value] of requestHeaders.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  return headers;
}

/** CORS 响应头 */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
  };
}

/** 构建输出响应头 */
function buildResponseHeaders(response) {
  const headers = new Headers();
  for (const [key, value] of response.headers.entries()) {
    if (!RESPONSE_BLOCKED.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  // 添加 CORS
  const cors = corsHeaders();
  for (const [k, v] of Object.entries(cors)) {
    headers.set(k, v);
  }
  return headers;
}

/** 智能重试：仅对可重试的 502/503 重试，backoff 0.5s, 1s */
const RETRYABLE = new Set([502, 503]);
const RETRY_TIMEOUT = 25000; // 25s 阈值，防止重试耗尽总时间

async function fetchWithRetry(url, options, startTime, maxAttempts = 2) {
  let lastError;
  let retries = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, options);
      if (RETRYABLE.has(response.status) && attempt < maxAttempts) {
        const elapsed = Date.now() - startTime;
        if (elapsed > RETRY_TIMEOUT) {
          console.warn(
            `[Retry] Attempt ${attempt} got ${response.status}, ` +
              `elapsed ${elapsed}ms > threshold. Skipping retry.`
          );
          response.retries = retries;
          return response;
        }
        console.warn(`[Retry] Attempt ${attempt} got ${response.status}. Retrying...`);
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
        console.warn(`[Retry] Attempt ${attempt} error: ${error.message}. Retrying...`);
        await new Promise((r) => setTimeout(r, attempt * 500));
      } else {
        if (elapsed >= RETRY_TIMEOUT) {
          console.warn(
            `[Retry] Attempt ${attempt} error: ${error.message}, ` +
              `elapsed ${elapsed}ms > threshold. Giving up.`
          );
        }
        break;
      }
    }
  }
  throw lastError || new Error('Max retry attempts reached');
}

// ============================================================
// 主入口
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, search } = url;
    const startTime = Date.now();
    const reqId = generateReqId();

    console.log(`[${reqId}] ${request.method} ${pathname}${search}`);

    // ---------- OPTIONS (预检) ----------
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // ---------- Models 列表 ----------
    if (
      pathname.endsWith('/models') ||
      pathname.includes('/v1/models') ||
      pathname.includes('/v1beta/openai/models')
    ) {
      return new Response(JSON.stringify(MODELS), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(),
        },
      });
    }

    try {
      // ---------- 构建上游 URL ----------
      let targetUrl = buildTargetUrl(pathname, search);
      const isOpenAICompat = targetUrl.includes('/v1beta/openai/');

      // ---------- 提取 API Key ----------
      const authHeader = request.headers.get('authorization') || '';
      let apiKey = '';
      if (authHeader.startsWith('Bearer ')) {
        apiKey = authHeader.slice(7).trim();
      }

      // ---------- 注入 API Key ----------
      // Google OpenAI 兼容端点: 用 ?key= 参数（和 Authorization 头二选一都行，?key= 更可靠）
      // 与 Vercel 版逻辑对齐：OpenAI 路径用 Authorization 头保持一致性
      const headers = cleanHeaders(request.headers);
      if (apiKey) {
        if (isOpenAICompat) {
          // OpenAI 兼容路径：保留 Authorization: Bearer 头，Google 官方支持
          // 不移除 headers，保持原样透传
        } else {
          // 原生 Gemini 路径：用 ?key= 传 API Key
          const urlWithKey = new URL(targetUrl);
          urlWithKey.searchParams.set('key', apiKey);
          targetUrl = urlWithKey.toString();
          headers.delete('authorization');
        }
      }

      // ---------- 读取并过滤请求体 ----------
      let body = null;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        try {
          const text = await request.text();
          body = text && text.trim() !== '' ? text : '{}';
        } catch (e) {
          body = '{}';
        }
        if (isOpenAICompat) {
          body = sanitizeOpenAIBody(body);
        }
      }

      // ---------- 转发请求 ----------
      const response = await fetchWithRetry(
        targetUrl,
        {
          method: request.method,
          headers,
          body,
          cache: 'no-store',
        },
        startTime
      );

      const latency = Date.now() - startTime;
      const retries = response.retries || 0;
      console.log(
        `[${reqId}] → ${response.status} (${latency}ms` +
          (retries > 0 ? `, retries=${retries}` : '') +
          `)`
      );

      // ---------- 构建响应 ----------
      const respHeaders = buildResponseHeaders(response);
      respHeaders.set('X-Request-Id', reqId);
      respHeaders.set('X-Proxy', 'cloudflare-workers');

      // ---------- 流式响应（SSE）处理 ----------
      const upstreamBody = response.body;
      const contentType = response.headers.get('content-type') || '';

      if (
        upstreamBody &&
        (contentType.includes('text/event-stream') ||
          contentType.includes('application/x-ndjson'))
      ) {
        // SSE 流式：客户端断线时中止上游读取
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const reader = upstreamBody.getReader();
        let aborted = false;

        // 异步读取 + 写入
        ctx.waitUntil(
          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done || aborted) {
                  break;
                }
                await writer.write(value);
              }
            } catch (err) {
              if (!aborted) {
                console.error(`[${reqId}] Stream read error: ${err.message}`);
              }
            } finally {
              try {
                await writer.close();
              } catch {}
              try {
                reader.cancel();
              } catch {}
            }
          })()
        );

        // 客户端断线信号
        request.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            console.warn(`[${reqId}] Client disconnected, cancelling stream`);
            reader.cancel().catch(() => {});
            writer.close().catch(() => {});
          },
          { once: true }
        );

        return new Response(readable, {
          status: response.status,
          statusText: response.statusText,
          headers: respHeaders,
        });
      }

      // ---------- 非流式响应 ----------
      let finalBody = upstreamBody || null;

      // ⭐ 关键修复：Google 有时对 4xx/5xx 返回空 body
      // 客户端（QClaw、Hermes）看到的就是 "400 no body"
      // 这里补一个结构化错误体
      if (!finalBody && response.status >= 400) {
        finalBody = JSON.stringify({
          error: {
            message: `上游返回 HTTP ${response.status}（空响应体）`,
            type: 'upstream_error',
            code: response.status,
            reqId,
          },
        });
        // 确保 Content-Type 是 JSON
        respHeaders.set('Content-Type', 'application/json');
      }

      return new Response(finalBody, {
        status: response.status,
        statusText: response.statusText,
        headers: respHeaders,
      });
    } catch (error) {
      console.error(`[${reqId}] Proxy Error:`, error.message);

      const isDev = env.NODE_ENV === 'development';
      const userMessage = isDev
        ? `Proxy Error: ${error.message}`
        : '代理请求失败，请稍后重试';

      return new Response(
        JSON.stringify({
          error: {
            message: userMessage,
            type: 'proxy_error',
            code: 502,
            reqId,
          },
        }),
        {
          status: 502,
          headers: {
            'Content-Type': 'application/json',
            'X-Request-Id': reqId,
            ...corsHeaders(),
          },
        }
      );
    }
  },
};