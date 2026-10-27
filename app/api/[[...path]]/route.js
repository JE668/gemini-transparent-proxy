// app/api/[[...path]]/route.js
// Gemini 透明代理 - 鲁棒增强版 (带智能重试与遥测统计)
// 增强: +Interactions API 代理 + Agent 模型自动路由

export const runtime = 'nodejs';
export const maxDuration = 60; // Hobby 上限 60s，Pro 上限 300s

import { HIGH_QUOTA_MODELS } from '../../../lib/models';
import { MODEL_FALLBACKS } from '../../../lib/model-fallbacks';

import { getQuotaDate } from '../../../lib/utils';
import { getRedis } from '../../../lib/redis';
import { handleResponsesApi } from '../../../lib/responses-handler';
import {
  responsesToInteraction,
  interactionToResponses,
  callInteractionsApi,
  getInteractionId,
} from '../../../lib/interactions';
// 请求体清洗 / URL 映射 / 限流 —— 均为零依赖纯模块，便于单元测试直接引入
import {
  GOOGLE_API_BASE,
  sanitizeOpenAIBody,
  cleanTools,
  buildTargetUrl,
} from '../../../lib/openai-compat';
import {
  computeClientFingerprint,
  checkRpmLimit,
  checkTpmLimit,
  parseRpmLimit,
} from '../../../lib/rate-limit';

// 调试：记录最近的请求信息（全局变量，Vercel serverless 实例内有效）
globalThis.__LAST_REQUEST = null;
globalThis.__LAST_RESPONSE = null;

const HOP_BY_HOP_HEADERS = [
  'host', 'connection', 'keep-alive', 'proxy-authorization',
  'proxy-authenticate', 'te', 'trailers', 'transfer-encoding',
  'upgrade', 'content-length'
];

const BLOCKED_RESPONSE_HEADERS = [
  'content-encoding', 'transfer-encoding', 'connection',
  'keep-alive', 'strict-transport-security'
];

async function getRequestBody(req) {
  const chunks = [];
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  // ⚠️ 必须做收尾 flush：否则末尾若残留不完整的多字节 UTF-8 序列会被静默丢弃，
  //    导致 JSON.parse 失败 → 500。decode() 不带 { stream: true } 即为 flush。
  chunks.push(decoder.decode());
  return chunks.join('');
}

function getCorsHeaders(req) {
 const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
 const reqOrigin = req.headers.get('origin') || '';
 let allowOrigin = '*';
 if (allowedOrigins.length > 0 && reqOrigin) {
 allowOrigin = allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0];
 }
 return {
 'Access-Control-Allow-Origin': allowOrigin,
 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
 'Access-Control-Allow-Headers': '*',
 'Access-Control-Expose-Headers': 'X-Request-Id, Content-Type',
 };
}

// 从请求体中取出 model（解析失败时返回 'unknown'）
function extractModelId(body) {
  try {
    const json = JSON.parse(body || '{}');
    return json.model || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 对「提前 return 的独立端点」执行限流。
 *
 * ⚠️ 为什么需要它：/v1/responses 与 /v1/interactions 在主流程中会提前 return，
 *    不会走到下面通用转发路径上的限流逻辑 —— 结果是 Codex（Responses API）
 *    流量完全不受 RPM / TPM 保护，会直接撞穿 Google 免费层配额。
 *    本函数把同样的限流规则补齐到这两条路径上。
 *
 * @returns {Promise<Response|null>} 需要拒绝时返回 429 Response；放行时返回 null
 */
async function enforceRateLimits({ req, reqId, body, modelId }) {
  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null; // anon → 无可归属配额主体，不限流
  const apiKey = authHeader.slice(7).trim();
  const fingerprint = await computeClientFingerprint(apiKey);
  const redis = getRedis();
  if (!redis) return null;

  const rpmLimit = parseRpmLimit(process.env.RATE_LIMIT_RPM);
  const rpmResult = await checkRpmLimit({ redis, fingerprint, rpmLimit });
  if (rpmResult.rejected) {
    const retryAfter = rpmResult.retryAfter;
    console.warn(`[${reqId}] Rate Limit: ${fingerprint} exceeded ${rpmLimit} RPM (retry after ${retryAfter}s)`);
    return new Response(JSON.stringify({
    error: {
    message: `请求过于频繁，每分钟最多 ${rpmLimit} 次，请 ${retryAfter} 秒后重试`,
    type: 'rate_limit_exceeded',
    code: 429
    }
    }), {
    status: 429,
    headers: {
    'Content-Type': 'application/json',
    'Retry-After': String(retryAfter),
    ...getCorsHeaders(req),
    }
    });
  }

  const tpmResult = await checkTpmLimit({ redis, fingerprint, modelId, body, openAICompat: true });
  if (tpmResult.rejected) {
    const tpmLimit = tpmResult.limit;
    const inputTokens = tpmResult.inputTokens;
    const retryAfter = tpmResult.retryAfter;
    console.warn(`[${reqId}] TPM Limit: ${modelId} ${fingerprint} would exceed ${tpmLimit}/min (need ${inputTokens}, retry after ${retryAfter}s)`);
    return new Response(JSON.stringify({
    error: {
    message: `模型 ${modelId} 每分钟输入 token 上限为 ${tpmLimit}，本次请求约 ${inputTokens} token 会超出，请 ${retryAfter}s 后重试或改用更大额度的模型`,
    type: 'token_rate_limit_exceeded',
    code: 429
    }
    }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter), ...getCorsHeaders(req) }
    });
  }

  return null;
}

function cleanHeaders(incomingHeaders) {
  const h = new Headers();
  const keepAuth = incomingHeaders.get('authorization');
  incomingHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.includes(lower)) return;
    if (lower === 'authorization') return;
    // 不传 origin/referer — Google 校验 origin 有可能拦住
    if (lower === 'origin' || lower === 'referer' || lower === 'referrer') return;
    // 不传 content-length — fetch 会自动设置
    if (lower === 'content-length') return;
    // 不传 host — fetch 自动设置
    if (lower === 'host') return;
    h.set(key, value);
  });
  return h;
}

function buildResponseHeaders(response, req, reqId) {
  const out = new Headers();
  out.set('X-Request-Id', reqId);
  const cors = getCorsHeaders(req);
  for (const [k, v] of Object.entries(cors)) {
    out.set(k, v);
  }
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (BLOCKED_RESPONSE_HEADERS.includes(lower)) return;
    if (lower === 'x-request-id') return;
    out.set(key, value);
  });
  return out;
}

function isHighDemand503(text) {
  if (!text) return false;
  try {
    const obj = JSON.parse(typeof text === 'string' ? text : '{}');
    if (obj.error?.message?.includes('high demand')) return true;
    if (obj.error?.status === 'UNAVAILABLE') return true;
  } catch {}
  return text.includes('high demand') || text.includes('UNAVAILABLE');
}

async function fetchWithRetry(url, options, startTime, maxRetries = 2) {
  let lastError = null;
  const MAX_TOTAL_MS = 45000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= MAX_TOTAL_MS) break;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(25000, MAX_TOTAL_MS - elapsed));
      const resp = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      resp._retries = attempt;
      return resp;
    } catch (err) {
      lastError = err;
      console.warn(`[fetchWithRetry] attempt ${attempt + 1}/${maxRetries + 1} failed: ${err?.message || err}`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 5000)));
      }
    }
  }
  throw lastError || new Error('All retry attempts failed');
}

export async function GET(req) {
  // /v1/models（含 /api/v1/models、/api/models）：返回真实模型目录，与 CF Worker 版行为一致
  const pathname = req?.nextUrl?.pathname || new URL(req.url).pathname;
  if (pathname.endsWith('/models')) {
    return new Response(JSON.stringify({ object: 'list', data: HIGH_QUOTA_MODELS }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
    });
  }
  return new Response(JSON.stringify({
    name: 'Gemini Transparent Proxy',
    version: '2.0.0',
    endpoints: {
      chat: 'POST /v1/chat/completions',
      responses: 'POST /v1/responses (Codex)',
      interactions: 'POST /v1/interactions (direct)',
      models: 'GET /v1/models',
      quota: 'GET /api/quota',
      debug: 'GET /api/debug',
      recent: 'GET /api/recent',
    },
    features: [
      'Models list (high-quota first)',
      'Responses API (Codex) with session persistence',
      'Interactions API (Agent models)',
      'Rate limiting (Redis sliding window)',
      'Model fallback on 503',
      'Dashboard /api/* endpoints',
    ],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
  });
}

export async function OPTIONS(req) {
  return new Response(null, { status: 204, headers: getCorsHeaders(req) });
}

export async function PUT(req) {
  return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
  });
}

export async function DELETE(req) {
  return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
  });
}

export async function POST(req) {
  const startTime = Date.now();
  const reqId = Date.now().toString(16).slice(-6) + Math.random().toString(16).slice(2, 6);

  const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
               || req.headers.get('x-real-ip')
               || 'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';

  try {
    const url = new URL(req.url);
    const { pathname, search } = url;

    if (pathname.endsWith('/models') || pathname.includes('/v1/models') || pathname.includes('/v1beta/openai/models')) {
      return new Response(JSON.stringify({ object: 'list', data: HIGH_QUOTA_MODELS }), {
      status: 200,
      headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(req),
      }
      });
    }

    // ── Responses API (Codex 客户端) ──
    if ((pathname === '/v1/responses' || pathname === '/api/v1/responses') && req.method === 'POST') {
      console.log(`[${reqId}] Responses API detected, delegating`);
      // ⚠️ 本分支会提前 return，不会经过通用转发路径上的限流逻辑 —— 必须在这里单独限流，
      //    否则 Codex 流量可以无限打 Google 免费层（这是之前真实存在的漏洞）。
      const rawBody = await getRequestBody(req);
      const limited = await enforceRateLimits({ req, reqId, body: rawBody, modelId: extractModelId(rawBody) });
      if (limited) return limited;
      return handleResponsesApi(req, reqId, rawBody);
    }
    if ((pathname === '/v1/responses' || pathname === '/api/v1/responses') && req.method === 'GET') {
      return new Response(JSON.stringify({ endpoint: '/v1/responses', methods: ['POST'], streaming: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
      });
    }

    // ── Interactions API 直连 (new) ──
    if ((pathname === '/v1/interactions' || pathname === '/api/v1/interactions') && req.method === 'POST') {
      console.log(`[${reqId}] Interactions API detected`);
      const rawBody = await getRequestBody(req);
      // ⚠️ 同 /v1/responses：本分支提前 return，需单独限流
      const limited = await enforceRateLimits({ req, reqId, body: rawBody, modelId: extractModelId(rawBody) });
      if (limited) return limited;
      const authHeader = req.headers.get('authorization') || '';
      const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

      let interactionsBody = {};
      try {
        interactionsBody = JSON.parse(rawBody);
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
        });
      }

      const resp = await callInteractionsApi(interactionsBody, apiKey);

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '{}');
        return new Response(errBody, {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
        });
      }

      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req), 'X-Request-Id': reqId },
      });
    }
    if ((pathname === '/v1/interactions' || pathname === '/api/v1/interactions') && req.method === 'GET') {
      return new Response(JSON.stringify({ endpoint: '/v1/interactions', methods: ['POST'], note: 'Direct Interactions API passthrough. For Codex Responses API, use /v1/responses instead.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
      });
    }

    let targetUrl = buildTargetUrl(pathname, search);
    const headers = cleanHeaders(req.headers);

    const isOpenAICompat = targetUrl.includes('/v1beta/openai/');
    const authHeader = req.headers.get('authorization') || '';
    let clientFingerprint = 'anon';
    let apiKey = '';
    if (authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.slice(7).trim();
    if (!isOpenAICompat) {
      const urlWithKey = new URL(targetUrl);
      urlWithKey.searchParams.set('key', apiKey);
      targetUrl = urlWithKey.toString();
      headers.delete('authorization');
    }
    clientFingerprint = await computeClientFingerprint(apiKey);
    }

    const redis = getRedis();

    const RATE_LIMIT_RPM = parseRpmLimit(process.env.RATE_LIMIT_RPM);
    const rpmResult = await checkRpmLimit({ redis, fingerprint: clientFingerprint, rpmLimit: RATE_LIMIT_RPM });
    if (rpmResult.rejected) {
    const retryAfter = rpmResult.retryAfter;
    console.warn(`[${reqId}] Rate Limit: ${clientFingerprint} exceeded ${RATE_LIMIT_RPM} RPM (retry after ${retryAfter}s)`);
    return new Response(JSON.stringify({
    error: {
    message: `请求过于频繁，每分钟最多 ${RATE_LIMIT_RPM} 次，请 ${retryAfter} 秒后重试`,
    type: 'rate_limit_exceeded',
    code: 429
    }
    }), {
    status: 429,
    headers: {
    'Content-Type': 'application/json',
    'Retry-After': String(retryAfter),
    ...getCorsHeaders(req),
    }
    });
    }

    const body = await getRequestBody(req);

    const reqHeaders = {};
    req.headers.forEach((v, k) => { if (k !== 'authorization') reqHeaders[k] = v; });
    globalThis.__LAST_REQUEST = {
      reqId,
      method: req.method,
      pathname,
      targetUrl,
      headers: reqHeaders,
      body: body ? (body.length > 2000 ? body.slice(0, 2000) + '...(truncated)' : body) : null,
      timestamp: new Date().toISOString()
    };

    console.log(`[${reqId}] Request: ${req.method} ${pathname}`);
    if (body && body !== '{}') {
      try {
        const bodyPreview = JSON.parse(body);
        console.log(`[${reqId}] Body keys: ${Object.keys(bodyPreview).join(', ')}`);
        if (bodyPreview.model) console.log(`[${reqId}] Model: ${bodyPreview.model}`);
        if (bodyPreview.stream !== undefined) console.log(`[${reqId}] Stream: ${bodyPreview.stream}`);
      } catch {}
    }
    console.log(`[${reqId}] Target URL: ${targetUrl}`);

    let modelId = 'unknown';
    if (body) {
      try {
        const json = JSON.parse(body);
        if (json.model) modelId = json.model;
      } catch (e) {}
    }
    if (modelId === 'unknown') {
      const modelMatch = targetUrl.match(/\/models\/([^/:]+)/);
      if (modelMatch && modelMatch[1]) {
        modelId = modelMatch[1];
      } else {
        try {
          const urlObj = new URL(targetUrl);
          const queryModel = urlObj.searchParams.get('model');
          if (queryModel) modelId = queryModel;
        } catch {}
      }
    }

    const sanitizedBody = isOpenAICompat ? sanitizeOpenAIBody(body) : body;

    let originalStreamRequested = false;
    let requestBodyForFetch = sanitizedBody;
    if (sanitizedBody && sanitizedBody !== '{}') {
    try {
    const parsed = JSON.parse(sanitizedBody);
    if (parsed.stream === true) {
    originalStreamRequested = true;
    parsed.stream = false;
    requestBodyForFetch = JSON.stringify(parsed);
    console.log(`[${reqId}] Converted stream=true to non-streaming for QClaw compatibility`);
    }
    } catch {}
    }

    // === TPM（每分钟输入 token）限流：根治 Google 免费层 16K 墙 ===
    let inputTokens = 0; // TPM 遥测用：本次请求估计输入 token 数（Vercel 为备份流量）
    const tpmResult = await checkTpmLimit({
      redis,
      fingerprint: clientFingerprint,
      modelId,
      body: requestBodyForFetch,
      openAICompat: isOpenAICompat,
    });
    inputTokens = tpmResult.inputTokens;
    if (tpmResult.rejected) {
      const tpmLimit = tpmResult.limit;
      const retryAfter = tpmResult.retryAfter;
      console.warn(`[${reqId}] TPM Limit: ${modelId} ${clientFingerprint} would exceed ${tpmLimit}/min (need ${inputTokens}, retry after ${retryAfter}s)`);
      return new Response(JSON.stringify({
        error: {
          message: `模型 ${modelId} 每分钟输入 token 上限为 ${tpmLimit}，本次请求约 ${inputTokens} token 会超出，请 ${retryAfter}s 后重试或改用更大额度的模型`,
          type: 'token_rate_limit_exceeded',
          code: 429
        }
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter), ...getCorsHeaders(req) }
      });
    }

    let response = await fetchWithRetry(targetUrl, {
      method: req.method,
      headers: headers,
      body: requestBodyForFetch,
      cache: 'no-store',
    }, startTime);
    let totalRetries = Number(response._retries) || 0;

    if (isOpenAICompat && body && (response.status === 429 || response.status === 500 || response.status === 503 || response.status === 524)) {
      const status = response.status;
      let shouldFallback = false;
      if (status === 429) {
        // 同模型按 Google 返回的 Retry-After 退避重试一次（封顶 10s）
        const retryAfter = Math.min(parseInt(response.headers.get('Retry-After') || '5', 10) || 5, 10);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        const retryResp = await fetchWithRetry(targetUrl, {
          method: req.method, headers, body: requestBodyForFetch, cache: 'no-store',
        }, startTime);
        totalRetries += Number(retryResp._retries) || 0;
        if (retryResp.status === 429 || retryResp.status === 500 || retryResp.status === 503 || retryResp.status === 524) {
          response = retryResp; // 仍失败 → 走模型降级
          shouldFallback = true;
        } else {
          response = retryResp; // 成功（同模型重试，modelId 保持不变，无需重解析）
        }
      } else if (status === 524 || status === 500) {
        shouldFallback = true;
      } else {
        // 503：用 clone() 读取错误文本，避免消费原响应体导致后续无法转发
        const errText = await response.clone().text().catch(() => '');
        if (isHighDemand503(errText)) {
          shouldFallback = true;
        }
      }
      if (shouldFallback) {
        let originalModel = modelId;
        try {
          originalModel = JSON.parse(body).model || modelId;
        } catch {}
        const fallbackModel = originalModel ? MODEL_FALLBACKS[originalModel] : null;
        if (fallbackModel) {
          const newBody = JSON.parse(requestBodyForFetch);
          newBody.model = fallbackModel;
          const fallbackResp = await fetchWithRetry(targetUrl, {
            method: req.method,
            headers: headers,
            body: JSON.stringify(newBody),
            cache: 'no-store',
          }, startTime);
          totalRetries += Number(fallbackResp._retries) || 0;
          console.log(`[${reqId}] Model fallback: ${originalModel} → ${fallbackModel} (${fallbackResp.status})`);
          if (fallbackResp.status !== 500 && fallbackResp.status !== 503 && fallbackResp.status !== 524 && fallbackResp.status !== 429) {
            response = fallbackResp;
            modelId = fallbackModel;
          } else {
            const origHeaders = buildResponseHeaders(response, req, reqId);
            response = new Response('', { status: response.status, statusText: response.statusText, headers: origHeaders });
          }
        }
      }
    }

    globalThis.__LAST_RESPONSE = {
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type'),
      timestamp: new Date().toISOString()
    };

    const latency = Date.now() - startTime;
    const date = getQuotaDate();
    const finalModelId = modelId === 'unknown' ? 'unknown-model' : modelId;

  const bjHour = (new Date().getUTCHours() + 8) % 24;

  const isSuccess = response.status < 400;
  const nowIso = new Date().toISOString();

  const recentEntry = JSON.stringify({
    ts: nowIso,
    status: response.status,
    model: finalModelId,
    latency,
    ua: userAgent,
    ip: clientIP,
  });

  const errorEntry = JSON.stringify({
    ts: nowIso,
    status: response.status,
    model: finalModelId,
    latency,
    message: `${response.status} ${response.statusText}`,
    ua: userAgent,
    ip: clientIP,
  });

  const slowEntry = JSON.stringify({
    ts: nowIso,
    status: response.status,
    model: finalModelId,
    ua: userAgent,
    ip: clientIP,
  });

  const SLOW_THRESHOLD_MS = 10000;

  const telemetryOps = redis ? [
    redis.incr(`status:${date}:${response.status}`),
    redis.incr(`timeline:${date}:h${bjHour}`),
    redis.lpush(`recent:${date}`, recentEntry),
    redis.ltrim(`recent:${date}`, 0, 29),
    ...(totalRetries > 0 ? [
      redis.incrby(`retries:${date}`, totalRetries),
    ] : []),
    ...(latency >= SLOW_THRESHOLD_MS ? [
      redis.zadd(`slow:${date}`, { score: latency, member: slowEntry }),
      redis.zremrangebyrank(`slow:${date}`, 0, -51),
    ] : []),
    ...(isSuccess ? [
      redis.incr(`quota:${date}:${finalModelId}`),
      redis.incr(`quota:global:${date}`),
      ...(inputTokens > 0 ? [
        redis.zadd(`tpm:${date}:${finalModelId}`, { score: Date.now(), member: String(inputTokens) }),
        redis.zremrangebyscore(`tpm:${date}:${finalModelId}`, 0, Date.now() - 60000),
      ] : []),
    ] : []),
    ...(!isSuccess ? [
      redis.lpush(`errors:${date}`, errorEntry),
      redis.ltrim(`errors:${date}`, 0, 29),
    ] : []),
  ] : [];

  if (telemetryOps.length > 0) {
    const results = await Promise.allSettled(telemetryOps);
    const failures = results.filter(r => r.status === 'rejected').length;
    if (failures > 0) console.warn(`[${reqId}] ${failures}/${telemetryOps.length} telemetry ops failed`);
  }

  const responseHeaders = buildResponseHeaders(response, req, reqId);

  if (originalStreamRequested && isSuccess) {
    console.log(`[${reqId}] Streaming response to client (converted from non-streaming)`);
    const text = await response.text();

    if (text.startsWith('{')) {
      try {
        const jsonResponse = JSON.parse(text);
        const streamContent = [];

        // Gemini → OpenAI 流式格式转换
        function createChunk(data) {
          return `data: ${JSON.stringify(data)}\n\n`;
        }

        // 处理 <thought> 标签 — 先发将 reasoning 内容提取
        let finalContent = jsonResponse.choices?.[0]?.message?.content || '';
        let reasoningContent = jsonResponse.choices?.[0]?.message?.reasoning_content || '';
        if (!reasoningContent && finalContent) {
          const thoughtMatch = finalContent.match(/<thought>([\s\S]*?)<\/thought>/);
          if (thoughtMatch) {
            reasoningContent = thoughtMatch[1];
            finalContent = finalContent.replace(/<thought>[\s\S]*?<\/thought>/, '').trim();
          }
        }

        // 发送 reasoning_content（如果有）
        if (reasoningContent) {
          const reasoningChunk = createChunk({
            id: jsonResponse.id,
            object: 'chat.completion.chunk',
            created: jsonResponse.created,
            model: jsonResponse.model,
            choices: [{
              index: 0,
              delta: { role: 'assistant', reasoning_content: reasoningContent, content: '' },
              finish_reason: null
            }]
          });
          streamContent.push(reasoningChunk);
        }

        // content（纯文本）
        const contentChunk = createChunk({
          id: jsonResponse.id,
          object: 'chat.completion.chunk',
          created: jsonResponse.created,
          model: jsonResponse.model,
          choices: [{
            index: 0,
            delta: finalContent ? { content: finalContent } : { role: 'assistant', content: '' },
            finish_reason: null
          }]
        });
        streamContent.push(contentChunk);

        // 结束 chunk
        if (jsonResponse.choices?.[0]?.finish_reason) {
          streamContent.push(createChunk({
            id: jsonResponse.id,
            object: 'chat.completion.chunk',
            created: jsonResponse.created,
            model: jsonResponse.model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: jsonResponse.choices[0].finish_reason
            }]
          }));
        }

        // usage chunk
        if (jsonResponse.usage) {
          streamContent.push(createChunk({
            id: jsonResponse.id,
            object: 'chat.completion.chunk',
            created: jsonResponse.created,
            model: jsonResponse.model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: null
            }],
            usage: jsonResponse.usage
          }));
        }

        streamContent.push('data: [DONE]\n\n');

        responseHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
        responseHeaders.set('Cache-Control', 'no-cache');
        responseHeaders.set('Connection', 'keep-alive');

        return new Response(streamContent.join(''), {
          status: 200,
          headers: responseHeaders
        });
      } catch (e) {
        console.error(`[${reqId}] Failed to parse response as JSON for streaming: ${e.message}`);
      }
    }
  }

  if (response.status === 204) {
    return new Response(null, { status: 204, headers: responseHeaders });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
  } catch (err) {
    console.error(`[${reqId}] Fatal: ${err?.message || err}`);
    const errorBody = JSON.stringify({
      error: { message: err?.message || 'Internal server error', type: 'proxy_error' },
      _reqId: reqId,
    });
    return new Response(errorBody, {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
    });
  }
}
