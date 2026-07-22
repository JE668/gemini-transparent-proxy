// app/api/[[...path]]/route.js
// Gemini 透明代理 - 鲁棒增强版 (带智能重试与遥测统计)
// 增强: +Interactions API 代理 + Agent 模型自动路由

export const runtime = 'nodejs';
export const maxDuration = 60; // Hobby 上限 60s，Pro 上限 300s

import { HIGH_QUOTA_MODELS } from '../../../lib/models';
import { TPM_LIMITS, estimateInputTokens } from '../../../lib/token-limit';

import { getQuotaDate } from '../../../lib/utils';
import { getRedis } from '../../../lib/redis';
import { handleResponsesApi } from '../../../lib/responses-handler';
import {
  responsesToInteraction,
  interactionToResponses,
  callInteractionsApi,
  getInteractionId,
} from '../../../lib/interactions';

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';

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
  return chunks.join('');
}

const GOOGLE_OPENAI_BLOCKED = new Set([
  'stream_options', 'reasoning_effort', 'frequency_penalty', 'presence_penalty',
  'logit_bias', 'logprobs', 'top_logprobs', 'seed', 'user', 'service_tier',
  'n', 'include_reasoning', 'store', 'metadata', 'parallel_tool_calls', 'response_format',
]);

function sanitizeOpenAIBody(body) {
  if (!body || body === '{}') return body;
  try {
    const json = JSON.parse(body);
    const cleaned = {};
    for (const key in json) {
      if (!GOOGLE_OPENAI_BLOCKED.has(key) && json[key] !== null) {
        cleaned[key] = json[key];
      }
    }
    // ⚠️ 递归清洗 tools[].function：只保留 name/description/parameters
    if (cleaned.tools && Array.isArray(cleaned.tools)) {
      cleaned.tools = cleanTools(cleaned.tools);
    }
    return JSON.stringify(cleaned);
  } catch (e) {
    // 非 JSON body 直接透传
    return body;
  }
}

function cleanTools(tools) {
  return tools.map(tool => {
    if (!tool || !tool.function) return tool;
    const cleaned = {};
    for (const key in tool) {
      if (key !== 'function') cleaned[key] = tool[key];
    }
    const fn = {};
    if (tool.function.name !== undefined) fn.name = tool.function.name;
    if (tool.function.description !== undefined) fn.description = tool.function.description;
    if (tool.function.parameters !== undefined) fn.parameters = tool.function.parameters;
    cleaned.function = fn;
    return cleaned;
  });
}

function buildTargetUrl(pathname, search) {
  const rules = [
    { prefix: '/api/v1/', replacement: '/v1beta/openai/' },
    { prefix: '/v1/', replacement: '/v1beta/openai/' },
    { prefix: '/api/', replacement: '/v1beta/openai/' },
  ];
  let targetPath = pathname;
  for (const { prefix, replacement } of rules) {
    if (targetPath.startsWith(prefix)) {
      targetPath = replacement + targetPath.slice(prefix.length);
      break;
    }
  }
  if (search) {
    return `${GOOGLE_API_BASE}${targetPath}${search}`;
  }
  return `${GOOGLE_API_BASE}${targetPath}`;
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

const MODEL_FALLBACKS = {
  'gemini-3-flash-preview': 'gemini-2.5-flash',
  'gemma-4-31b-it': 'gemini-3.5-flash-lite',       // 429/过载 → 250K TPM，真正缓解
  'gemma-4-26b-a4b-it': 'gemini-3.5-flash-lite',
};

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
      return handleResponsesApi(req, reqId);
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
    try {
    const keyData = new TextEncoder().encode(apiKey);
    const hashBuf = await crypto.subtle.digest('SHA-1', keyData);
    const hashArr = Array.from(new Uint8Array(hashBuf));
    clientFingerprint = hashArr.slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {}
    }

    const redis = getRedis();

    const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '15', 10);
    if (RATE_LIMIT_RPM > 0 && clientFingerprint !== 'anon' && redis) {
    const WINDOW_MS = 60 * 1000;
    const rlKey = `ratelimit:${clientFingerprint}`;
    const nowMs = Date.now();
    const rlScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {1, oldest[2]}
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, math.ceil(window / 1000) + 60)
return {0, count + 1}
`;
    try {
    const member = `${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await redis.eval(rlScript, [rlKey], [String(nowMs), String(WINDOW_MS), String(RATE_LIMIT_RPM), member]);
    const rejected = Array.isArray(res) && Number(res[0]) === 1;
    if (rejected) {
    const oldestScore = Number(res[1]);
    let retryAfter = 60;
    if (Number.isFinite(oldestScore) && oldestScore > 0) {
    retryAfter = Math.max(1, Math.ceil((oldestScore + WINDOW_MS - nowMs) / 1000));
    }
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
    } catch (e) {
    console.error(`[${reqId}] Rate limiter error (fail-open): ${e?.message || e}`);
    }
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
    const tpmLimit = TPM_LIMITS[modelId];
    if (isOpenAICompat && tpmLimit && clientFingerprint !== 'anon' && redis) {
      try {
        const parsedForTokens = JSON.parse(requestBodyForFetch || '{}');
        inputTokens = estimateInputTokens(parsedForTokens);
        const tpmKey = `tpm:${modelId}:${clientFingerprint}`;
        const nowMs = Date.now();
        const WINDOW_MS = 60 * 1000;
        // 滑动窗口：sum(窗口内 token) + 本次 cost > limit 则拒绝，返回 Retry-After
        const tpmScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local items = redis.call('ZRANGEBYSCORE', key, now - window, now)
local sum = 0
for i=1,#items do
  local c = string.match(items[i], '^(%d+)')
  if c then sum = sum + tonumber(c) end
end
if sum + cost > limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfter = 60
  if oldest[2] then retryAfter = math.ceil((tonumber(oldest[2]) + window - now) / 1000) end
  return {0, sum, retryAfter}
end
redis.call('ZADD', key, now, cost .. ':' .. now .. ':' .. math.random())
redis.call('PEXPIRE', key, window + 2000)
return {1, sum + cost, 0}
`;
        const res = await redis.eval(tpmScript, [tpmKey], [String(nowMs), String(WINDOW_MS), String(tpmLimit), String(inputTokens)]);
        const allowed = Array.isArray(res) && Number(res[0]) === 1;
        if (!allowed) {
          const retryAfter = Math.max(1, Number(res[2]) || 60);
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
      } catch (e) {
        console.error(`[${reqId}] TPM limiter error (fail-open): ${e?.message || e}`);
      }
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
          response = retryResp; // 成功
          modelId = JSON.parse(requestBodyForFetch).model;
        }
      } else if (status === 524 || status === 500 || isHighDemand503(await response.text())) {
        shouldFallback = true;
      }
      if (shouldFallback) {
        const originalModel = JSON.parse(body).model;
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
