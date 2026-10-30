// app/api/[[...path]]/route.js
// Gemini 透明代理 - 鲁棒增强版 (带智能重试与遥测统计)
// 增强: +Interactions API 代理 + Agent 模型自动路由

export const runtime = 'nodejs';
export const maxDuration = 60; // Hobby 上限 60s，Pro 上限 300s

import { HIGH_QUOTA_MODELS } from '../../../lib/models';
import { MODEL_FALLBACKS } from '../../../lib/model-fallbacks';
import { APP_VERSION } from '../../../lib/version';

import { getQuotaDate, getBeijingHour } from '../../../lib/utils';
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
  redactUrl,
} from '../../../lib/openai-compat';
import {
  computeClientFingerprint,
  checkRpmLimit,
  checkTpmLimit,
  parseRpmLimit,
} from '../../../lib/rate-limit';
import { hasApiKey, missingApiKeyResponse } from '../../../lib/client-auth';
// 流式转换（thought 状态机 / tool_calls SSE 拆分 / 真流式直通）—— 与 CF Worker 共用同一份实现
import {
  isQclawCompatClient,
  buildChatCompletionChunks,
  buildSseError,
  transformUpstreamSSE,
  SSE_DONE,
} from '../../../lib/chat-stream';
// 上游重试策略 —— 与 CF Worker 共用同一份实现
import { fetchWithRetry as sharedFetchWithRetry } from '../../../lib/fetch-retry';
// 遥测事件生成 —— 与 CF Worker 共用同一份实现（补齐 Dashboard 空面板 + 429 计入）
import {
  buildTelemetryEvents,
  buildRateLimitTelemetryEvents,
  telemetryEventsToRedisPromises,
} from '../../../lib/telemetry';

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
 * ⚠️ 限流拒绝也会写遥测（status:{date}:429 + errors + timeline），
 *    否则 Dashboard 的请求总量 / 错误率看不到「被代理拦掉」的请求，运维会误判流量正常。
 *
 * @returns {Promise<Response|null>} 需要拒绝时返回 429 Response；放行时返回 null
 */
async function enforceRateLimits({ req, reqId, body, modelId, clientIP = 'unknown', userAgent = 'unknown' }) {
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
    await recordRateLimitTelemetry({
      redis,
      reqId,
      modelId,
      fingerprint,
      clientIP,
      userAgent,
      reason: `rpm_limit_exceeded (${rpmLimit} RPM)`,
    });
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
    await recordRateLimitTelemetry({
      redis,
      reqId,
      modelId,
      fingerprint,
      clientIP,
      userAgent,
      reason: `tpm_limit_exceeded (${tpmLimit}/min, need ${inputTokens})`,
    });
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

/**
 * 把代理侧限流拒绝（429）写入遥测。
 *
 * ⚠️ 此前限流直接 return 429，不写任何遥测 ——
 *    Dashboard 的「请求总量 / 错误率 / 错误日志」都看不到这些请求。
 *    遥测写入失败不能影响限流本身的响应（fail-open on telemetry）。
 *
 * @param {object} opts
 */
async function recordRateLimitTelemetry({ redis, reqId, modelId, fingerprint, clientIP, userAgent, reason }) {
  if (!redis) return;
  try {
    const events = buildRateLimitTelemetryEvents({
      date: getQuotaDate(),
      hour: getBeijingHour(),
      status: 429,
      model: modelId || 'unknown-model',
      ua: userAgent,
      ip: clientIP,
      fingerprint,
      reason,
    });
    const ops = telemetryEventsToRedisPromises(redis, events);
    const results = await Promise.allSettled(ops);
    const failures = results.filter(r => r.status === 'rejected').length;
    if (failures > 0) console.warn(`[${reqId}] ${failures}/${ops.length} rate-limit telemetry ops failed`);
  } catch (err) {
    console.warn(`[${reqId}] rate-limit telemetry failed: ${err?.message || err}`);
  }
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

/**
 * 上游 fetch + 重试。
 * ⚠️ 实现已收敛到 lib/fetch-retry.js（Vercel 与 CF Worker 共用）。
 *    旧实现只重试网络异常、不重试 5xx，导致同一次上游抖动在备份部署上直接失败。
 */
async function fetchWithRetry(url, options, startTime, maxRetries = 2) {
  return sharedFetchWithRetry(url, options, startTime, { maxAttempts: maxRetries + 1 });
}

export async function GET(req) {
  // /v1/models（含 /api/v1/models、/api/models）：返回真实模型目录，与 CF Worker 版行为一致
  // ⚠️ 端点会暴露完整模型清单与配额信息，必须携带 API Key（README 端点表要求 Google API Key）。
  //    统一在 lib/client-auth.js 校验，保证 Vercel 与 CF 两端行为一致。
  const pathname = req?.nextUrl?.pathname || new URL(req.url).pathname;
  if (pathname.endsWith('/models')) {
    if (!hasApiKey(req)) return missingApiKeyResponse();
    return new Response(JSON.stringify({ object: 'list', data: HIGH_QUOTA_MODELS }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
    });
  }
  return new Response(JSON.stringify({
    name: 'Gemini Transparent Proxy',
    version: APP_VERSION,
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
      const limited = await enforceRateLimits({ req, reqId, body: rawBody, modelId: extractModelId(rawBody), clientIP, userAgent });
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
      // ⚠️ 鉴权统一走 header，绝不再把 Key 拼进 URL query。
      //    旧实现用 `?key=xxx`，导致完整 Key 出现在：
      //      ① console.log 的 Target URL（Vercel 日志）
      //      ② globalThis.__LAST_REQUEST（/api/debug-last 回显）
      //    Google 端点同时支持 `Authorization: Bearer` 与 `x-goog-api-key`，
      //    这里两个都带上，兼容原生端点与 OpenAI 兼容端点。
      headers.delete('authorization');
      headers.set('authorization', `Bearer ${apiKey}`);
      headers.set('x-goog-api-key', apiKey);
      clientFingerprint = await computeClientFingerprint(apiKey);
    }

    const redis = getRedis();

    const RATE_LIMIT_RPM = parseRpmLimit(process.env.RATE_LIMIT_RPM);
    const rpmResult = await checkRpmLimit({ redis, fingerprint: clientFingerprint, rpmLimit: RATE_LIMIT_RPM });
    if (rpmResult.rejected) {
    const retryAfter = rpmResult.retryAfter;
    console.warn(`[${reqId}] Rate Limit: ${clientFingerprint} exceeded ${RATE_LIMIT_RPM} RPM (retry after ${retryAfter}s)`);
    // ⚠️ 限流拒绝也要计入遥测，否则 Dashboard 看不到被代理拦掉的请求
    //    注意：此处 modelId 尚未从请求体解析（解析发生在下游），
    //    所以统一记为 'unknown-model'，避免引用未定义变量。
    await recordRateLimitTelemetry({
      redis,
      reqId,
      modelId: 'unknown-model',
      fingerprint: clientFingerprint,
      clientIP,
      userAgent,
      reason: `rpm_limit_exceeded (${RATE_LIMIT_RPM} RPM)`,
    });
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
    // ⚠️ targetUrl 必须脱敏后再留存：历史上 API Key 是拼在 URL query 里的，
    //    /api/debug-last 会把这里的 targetUrl 原样回显 → 完整 Key 泄漏。
    //    现在 Key 走 header（不再进 URL），这里仍统一 redactUrl 兜底。
    globalThis.__LAST_REQUEST = {
      reqId,
      method: req.method,
      pathname,
      targetUrl: redactUrl(targetUrl),
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

    // ⚠️ 流式策略（Vercel 与 CF Worker 现已完全一致）：
    //    · QClaw / WorkBuddy 客户端 → 改非流式发给 Google，取回完整 JSON 后手工拆成 SSE
    //      （这类客户端对 SSE 格式敏感，直通 Google 原生流会解析失败）
    //    · 其它客户端 → 保留 stream=true，走真流式直通（实时、不会等完整响应）
    //    旧实现对所有客户端一律 stream=false，既牺牲了普通客户端的实时性，
    //    也让 Vercel 端缺少 CF 端已有的 thought 状态机与 tool_calls 拆分能力。
    let originalStreamRequested = false;
    let qclawCompatMode = false;
    let requestBodyForFetch = sanitizedBody;
    if (sanitizedBody && sanitizedBody !== '{}') {
    try {
    const parsed = JSON.parse(sanitizedBody);
    if (parsed.stream === true) {
    originalStreamRequested = true;
    qclawCompatMode = isQclawCompatClient(userAgent);
    if (qclawCompatMode) {
      parsed.stream = false;
      requestBodyForFetch = JSON.stringify(parsed);
      console.log(`[${reqId}] QClaw-compatible client detected (${userAgent}) → stream=true converted to non-streaming upstream`);
    }
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
      // ⚠️ 限流拒绝也要计入遥测，否则 Dashboard 看不到被代理拦掉的请求
      await recordRateLimitTelemetry({
        redis,
        reqId,
        modelId,
        fingerprint: clientFingerprint,
        clientIP,
        userAgent,
        reason: `tpm_limit_exceeded (${tpmLimit}/min, need ${inputTokens})`,
      });
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

    const bjHour = getBeijingHour();

    // ⚠️ 遥测写入统一收敛到 lib/telemetry.js（与 CF Worker 共用同一份实现）：
    //    · 补齐此前「只有读取方、没有写入方」的 latencySum / latencyCount /
    //      clients:{date}:* / client:info:* → Dashboard 的平均延迟与客户端面板不再恒空
    //    · 统一 status / timeline / recent / errors / quota / tpm / retries / slow 的 key 与口径
    const telemetryEvents = buildTelemetryEvents({
      date,
      hour: bjHour,
      status: response.status,
      model: finalModelId,
      latency,
      ua: userAgent,
      ip: clientIP,
      fingerprint: clientFingerprint,
      inputTokens,
      totalRetries,
    });

    const telemetryOps = telemetryEventsToRedisPromises(redis, telemetryEvents);

  if (telemetryOps.length > 0) {
    const results = await Promise.allSettled(telemetryOps);
    const failures = results.filter(r => r.status === 'rejected').length;
    if (failures > 0) console.warn(`[${reqId}] ${failures}/${telemetryOps.length} telemetry ops failed`);
  }

  const responseHeaders = buildResponseHeaders(response, req, reqId);

  // ═══════════════════════════════════════════════════════════
  // 流式响应（与 CF Worker 共用 lib/chat-stream.js 的同一份实现）
  // ═══════════════════════════════════════════════════════════
  if (originalStreamRequested) {
    // ── 情况 A：QClaw 兼容模式（上游已被改为非流式）──
    if (qclawCompatMode) {
      console.log(`[${reqId}] Streaming response to client (QClaw compat: non-streaming upstream → manual SSE split)`);
      const text = await response.text();
      if (text.trimStart().startsWith('{')) {
        try {
          const jsonResponse = JSON.parse(text);
          // ⚠️ 共享实现里包含 reasoning_content → content → tool_calls → finish_reason
          //    的完整拆分（此前 Vercel 端缺 tool_calls 分支 → 工具调用直接丢失）
          const chunks = buildChatCompletionChunks(jsonResponse);

          // usage chunk（若上游返回）
          if (jsonResponse.usage) {
            chunks.push('data: ' + JSON.stringify({
              id: jsonResponse.id,
              object: 'chat.completion.chunk',
              created: jsonResponse.created,
              model: jsonResponse.model,
              choices: [{ index: 0, delta: {}, finish_reason: null }],
              usage: jsonResponse.usage,
            }) + '\n\n');
          }

          chunks.push(SSE_DONE);

          responseHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
          responseHeaders.set('Cache-Control', 'no-cache');
          responseHeaders.set('Connection', 'keep-alive');
          responseHeaders.set('X-Accel-Buffering', 'no');

          return new Response(chunks.join(''), {
            status: 200,
            headers: responseHeaders
          });
        } catch (e) {
          console.error(`[${reqId}] Failed to parse response as JSON for streaming: ${e.message}`);
        }
      }
    }

    // ── 情况 B：真流式直通（非 QClaw 客户端）──
    const contentType = response.headers.get('content-type') || '';
    if (isSuccess && response.body && contentType.includes('text/event-stream')) {
      responseHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
      responseHeaders.set('Cache-Control', 'no-cache');
      responseHeaders.set('Connection', 'keep-alive');
      responseHeaders.set('X-Accel-Buffering', 'no');

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            // ⚠️ 共享实现：跨 SSE 事件的 <thought> / <|thought> 状态机 +
            //    结束时补齐 finish_reason（此前 Vercel 端完全没有 → 思考内容泄漏 / empty stream）
            for await (const piece of transformUpstreamSSE(response.body, { reqId })) {
              controller.enqueue(encoder.encode(piece));
            }
            controller.enqueue(encoder.encode(SSE_DONE));
          } catch (err) {
            console.error(`[${reqId}] Stream error: ${err?.message || err}`);
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        status: 200,
        headers: responseHeaders
      });
    }

    // ── 情况 C：上游报错但客户端在等 SSE ──
    // 必须把错误包成 `data: {...}`，否则客户端解析器看到 JSON 会直接崩（"no body"）
    if (!isSuccess) {
      const errorMsg = await response.text().catch(() => 'No error body');
      responseHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
      responseHeaders.set('Cache-Control', 'no-cache');
      responseHeaders.set('Connection', 'keep-alive');
      return new Response(buildSseError(response.status, errorMsg, reqId), {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
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
