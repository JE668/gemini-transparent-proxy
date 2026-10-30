import { handleResponses } from './responses.js';
// ⚠️ 单一数据源：模型目录 / TPM 额度 / token 估算 / 请求体清洗 统一从 lib/ 引入。
//    CF Worker 虽然独立部署，但 wrangler（esbuild）会把这些纯模块一并打进产物，
//    从根上消除「Vercel 与 CF Worker 各维护一份、改一边忘另一边」的线上事故来源。
import { HIGH_QUOTA_MODELS } from '../../lib/models.js';
import { TPM_LIMITS, estimateInputTokens } from '../../lib/token-limit.js';
import { sanitizeOpenAIBody, buildTargetUrl, redactUrl } from '../../lib/openai-compat.js';
import { extractBearerToken } from '../../lib/client-auth.js';
// 流式转换（thought 状态机 / tool_calls SSE 拆分 / 真流式直通）—— 与 Vercel 端共用同一份实现
import {
  isQclawCompatClient,
  buildChatCompletionChunks,
  buildSseError,
  transformUpstreamSSE,
  SSE_DONE,
} from '../../lib/chat-stream.js';
// 上游重试策略 —— 与 Vercel 端共用同一份实现
import { fetchWithRetry as sharedFetchWithRetry } from '../../lib/fetch-retry.js';
import { MODEL_FALLBACKS } from '../../lib/model-fallbacks.js';
import { getQuotaDate, getBeijingHour } from '../../lib/utils.js';
// 遥测事件生成 —— 与 Vercel 端共用同一份实现（补齐 Dashboard 空面板 + 429 计入）
import {
  buildTelemetryEvents,
  buildRateLimitTelemetryEvents,
  telemetryEventsToUpstashCommands,
} from '../../lib/telemetry.js';
// 客户端指纹（API Key → 稳定短哈希）—— 与 Vercel 端共用同一份实现
import {
  computeClientFingerprint,
  parseRpmLimit,
  resolveRateLimitSubject,
} from '../../lib/rate-limit.js';

/**
 * Gemini Transparent Proxy — Cloudflare Workers Edition (Ultra-Compatible Version)
 * 
 * 修复重点：
 * 1. 彻底解决 QClaw 400 错误：实现“错误 SSE 包装”。如果客户端请求 stream=true 但上游返回 400，将错误信息包装成 SSE 格式返回，避免客户端解析崩溃。
 * 2. 增强稳定性：引入 Body 白名单机制，剔除所有可能引起 Google API 400 报错的冗余字段。
 * 3. 保持 Real-time Stream: TransformStream 实时转发响应，保留 <thought> 标签供客户端识别。
 */

// Google Gemini OpenAI-compatible API 不支持的字段黑名单（黑名单 vs 白名单：只删明确不支持的字段，其他全部透传）
// → 该清洗逻辑已收进 lib/openai-compat.js，CF 端统一经 sanitizeOpenAIBody 调用（与 Vercel 端共用同一份定义）

const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authorization',
  'proxy-authenticate', 'te', 'trailers', 'transfer-encoding',
  'upgrade', 'content-length',
]);

const RESPONSE_BLOCKED = new Set([
  'content-encoding', 'transfer-encoding', 'connection',
  'keep-alive', 'strict-transport-security',
]);

// 免费层可用模型目录（与 lib/models.js 的 HIGH_QUOTA_MODELS 保持 id 一致）。
// 数据来源：控制台配额导出 + Google ListModels 实测（每个 id 均为该 key 下真实可调用名）。
// 仅用于 /v1/models 对外展示，真实请求模型名来自客户端请求体。
// 注：仅列出走文本 Chat Completions（generateContent）端点的模型；
//     Imagen（predict）/ Embedding（embedContent）端点不同，详见 README「免费层额度速查表」。
const MODELS = {
  object: 'list',
  data: HIGH_QUOTA_MODELS,
};

function generateReqId() {
  return Date.now().toString(16).slice(-6) + Math.random().toString(16).slice(2, 6);
}

// ⚠️ 请求体清洗（sanitizeOpenAIBody）与上游 URL 映射（buildTargetUrl）
//    统一从 ../../lib/openai-compat.js 引入，与 Vercel 端共用同一份实现，
//    避免「两端各维护一份、改一边忘另一边」的行为分叉。

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

// ⚠️ 可重试状态码与退避策略已收敛到 lib/fetch-retry.js（Vercel 与 CF Worker 共用）

// 内存滑动窗口限流器（每个 Worker 实例独立计数，CF 的多实例间不共享）
// ⚠️ 归属维度：按 API Key 指纹（与 Vercel 端 lib/rate-limit.js 一致），
//    不再按客户端 IP —— 否则同一批用户切到 CF 就拿到了另一份额度。
class RateLimiter {
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.requests = new Map();
  }

  check(key, limit = this.maxRequests) {
    // limit <= 0 → 不限流（与 Vercel 端 RATE_LIMIT_RPM=0 的语义一致）
    if (!limit || limit <= 0) return true;
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let timestamps = this.requests.get(key) || [];
    // 清除窗口外的旧记录
    timestamps = timestamps.filter(t => t > windowStart);

    if (timestamps.length >= limit) {
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

// ===== 输入 token（TPM）限流：根治 Google 免费层 16K 墙 =====
// ⚠️ 已改为从 lib/token-limit.js 引入，与 Vercel 端天然保持一致


// 按模型 + IP 的每分钟输入 token 滑动窗口（内存，单实例；多实例下与 RPM 限流同样存在轻微不一致，由下面的 429 重试/降级兜底）
class TokenRateLimiter {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.buckets = new Map(); // key `${modelId}:${ip}` -> [{ts, tokens}]
  }
  check(modelId, clientIP, tokens) {
    const limit = TPM_LIMITS[modelId];
    if (!limit) return { allowed: true };
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const key = `${modelId}:${clientIP}`;
    let arr = this.buckets.get(key) || [];
    arr = arr.filter(e => e.ts > windowStart);
    const sum = arr.reduce((s, e) => s + e.tokens, 0);
    if (sum + tokens > limit) {
      const oldest = arr.length ? arr[0].ts : now;
      const retryAfter = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      this.buckets.set(key, arr);
      return { allowed: false, retryAfter, sum, limit };
    }
    arr.push({ ts: now, tokens });
    this.buckets.set(key, arr);
    return { allowed: true };
  }
  cleanup() {
    const windowStart = Date.now() - this.windowMs;
    for (const [key, arr] of this.buckets) {
      const filtered = arr.filter(e => e.ts > windowStart);
      if (!filtered.length) this.buckets.delete(key);
      else this.buckets.set(key, filtered);
    }
  }
}
const tokenRateLimiter = new TokenRateLimiter(60 * 1000);

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

/**
 * 上游 fetch + 重试。
 * ⚠️ 实现已收敛到 lib/fetch-retry.js（Vercel 与 CF Worker 共用）。
 *    旧 CF 版会重试 502/503/429 但忽略 Retry-After；旧 Vercel 版完全不重试 5xx。
 */
async function fetchWithRetry(url, options, startTime, maxAttempts = 2) {
  return sharedFetchWithRetry(url, options, startTime, {
    maxAttempts,
    onRetry: ({ attempt, status }) => {
      console.warn(`[fetchWithRetry] retry #${attempt} after ${status || 'network error'}`);
    },
  });
}

/** 模型降级链：Google 429 token 配额 / 503 high demand / 524 时自动切换模型
 * （跳过同为 16K TPM 的 26b，直奔 250K TPM 的 Flash-Lite；
 *   降级目标取 RPD 500 的 gemini-3.5-flash-lite 而非 RPD 仅 20 的 gemini-2.5-flash，
 *   与 Vercel 端 app/api/[[...path]]/route.js 保持一致） */
/** 检测 Google 503 UNAVAILABLE 错误体 */
function isHighDemand503(bodyText) {
  if (!bodyText || typeof bodyText !== 'string') return false;
  return bodyText.includes('UNAVAILABLE') || bodyText.includes('high demand');
}

// ⚠️ 配额日界（quota date）实现已收敛到 lib/utils.js（Vercel 与 CF Worker 共用同一份）。
//    旧实现在这里内联一份副本，减 15 小时 → 实际翻转点是北京时间 23:00，
//    与注释声明的 15:00、README 的说明三者互相矛盾。

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

/** 从请求体中取出 model（解析失败时返回 'unknown'） */
function extractModelId(body) {
  if (!body || typeof body !== 'object') return 'unknown';
  return body.model || 'unknown';
}

/**
 * 对「提前 return 的独立端点」执行限流。
 *
 * ⚠️ 为什么需要它：/v1/responses 与 /v1/interactions 在主流程中会提前 return，
 *    不会经过通用转发路径上的限流 —— 结果是 Codex（Responses API）流量
 *    完全不受 RPM / TPM 保护，会直接撞穿 Google 免费层配额。
 *
 * 语义与 Vercel 端保持一致：RPM 按客户端 IP，TPM 按「模型 + IP」。
 *
 * @returns {Response|null} 需要拒绝时返回 429 Response；放行时返回 null
 */
function enforceRateLimits({ reqId, clientIP, subject, body, modelId, env, ctx, userAgent, startTime, rpmLimit }) {
  // ⚠️ 限流归属主体：按 API Key 指纹（与 Vercel 端一致）。
  //    subject 为 null（无 API Key / anon）→ 无可归属配额主体 → 不限流，
  //    与 Vercel 端 fingerprint === 'anon' 不限流的约定保持一致。
  if (subject) {
    if (!rateLimiter.check(subject, rpmLimit)) {
      // ⚠️ 限流拒绝也要计入遥测，否则 Dashboard 看不到被代理拦掉的请求
      recordRateLimitTelemetry({ env, ctx, reqId, modelId, clientIP, userAgent, startTime, reason: 'rpm_limit_exceeded' });
      return new Response(JSON.stringify({
        error: {
          message: '请求过于频繁，请稍后重试',
          type: 'rate_limit_error',
          code: 429,
          reqId,
        }
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
          'X-Request-Id': reqId,
          ...corsHeaders(),
        },
      });
    }
  }

  // TPM 限流同样按归属主体（API Key 指纹）计量，
  // 否则同一用户换 IP 就能绕过每分钟 token 墙。
  if (subject) {
    const inputTokens = estimateInputTokens(body);
    const tpmRes = tokenRateLimiter.check(modelId, subject, inputTokens);
    if (!tpmRes.allowed) {
      // ⚠️ 限流拒绝也要计入遥测，否则 Dashboard 看不到被代理拦掉的请求
      recordRateLimitTelemetry({
        env, ctx, reqId, modelId, clientIP, userAgent, startTime,
        reason: `tpm_limit_exceeded (${tpmRes.limit}/min, need ${inputTokens})`,
      });
      return new Response(JSON.stringify({
        error: {
          message: `模型 ${modelId} 每分钟输入 token 上限为 ${tpmRes.limit}，本次请求约 ${inputTokens} token 会超出，请 ${tpmRes.retryAfter}s 后重试或改用更大额度的模型`,
          type: 'token_rate_limit_exceeded',
          code: 429,
          reqId,
        }
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(tpmRes.retryAfter),
          'X-Request-Id': reqId,
          ...corsHeaders(),
        },
      });
    }
  }

  return null;
}

/**
 * 把代理侧限流拒绝（429）写入遥测（fire-and-forget）。
 *
 * ⚠️ 此前限流直接 return 429，不写任何遥测 ——
 *    Dashboard 的「请求总量 / 错误率 / 错误日志」都看不到这些请求。
 *
 * @param {object} opts
 */
function recordRateLimitTelemetry({ env, ctx, reqId, modelId, clientIP, userAgent, startTime, reason }) {
  if (!env || !ctx) return;
  try {
    const events = buildRateLimitTelemetryEvents({
      date: getQuotaDate(),
      hour: getBeijingHour(),
      status: 429,
      model: modelId || 'unknown-model',
      latency: startTime ? Date.now() - startTime : 0,
      ua: userAgent || 'unknown',
      ip: clientIP || 'unknown',
      fingerprint: '',
      reason,
    });
    const cmds = telemetryEventsToUpstashCommands(events);
    ctx.waitUntil(upstashPipe(env, cmds));
  } catch (err) {
    console.warn(`[${reqId}] rate-limit telemetry failed: ${err?.message || err}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, search } = url;
    const startTime = Date.now();
    // 清理过期限流条目（轻量操作，每个请求执行一次）
    ctx.waitUntil(Promise.resolve(rateLimiter.cleanup()));
    ctx.waitUntil(Promise.resolve(tokenRateLimiter.cleanup()));
    const reqId = generateReqId();

    // 客户端 IP：用于遥测归因（限流归属主体改为 API Key 指纹，见下方）。
    // ⚠️ 必须在这里就算好 —— /v1/responses 与 /v1/interactions 会在下面提前 return。
    const rawIP = (request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
    const clientIP = normalizeIP(rawIP);

    // ⚠️ 限流归属主体：按 API Key 指纹（与 Vercel 端 lib/rate-limit.js 一致）。
    //    旧实现按客户端 IP 计量 → 同一批用户切到 CF 就拿到了另一份额度；
    //    换 IP 也能绕过每分钟 token 墙。
    //    无 API Key（anon）→ 无可归属配额主体 → 不限流（与 Vercel 端一致）。
    let rateLimitSubject = null;
    try {
      const bearer = extractBearerToken(request);
      if (bearer) {
        rateLimitSubject = resolveRateLimitSubject(await computeClientFingerprint(bearer));
      }
    } catch {
      rateLimitSubject = null;
    }

    // RPM 上限：与 Vercel 端共用同一套解析规则（默认 15，可用 RATE_LIMIT_RPM 覆盖，0 = 关闭）
    const rpmLimit = parseRpmLimit(env.RATE_LIMIT_RPM);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 调试端点：返回环境变量状态（不暴露值）
    // ⚠️ 安全：旧实现完全公开，任何人都能探测部署配置是否存在。
    //    现在要求 Bearer 密码匹配 env.DASHBOARD_PASSWORD；
    //    未配置密码时直接关闭该端点（404），不再泄露部署信息。
    if (pathname.endsWith('/v1/env') || pathname.endsWith('/env')) {
      const dashPassword = env.DASHBOARD_PASSWORD || '';
      const provided = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (!dashPassword || provided !== dashPassword) {
        return new Response(JSON.stringify({ error: 'Not Found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
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
      // ⚠️ 端点会暴露完整模型清单与配额信息，必须携带 API Key（与 Vercel 端一致）。
      if (!extractBearerToken(request)) {
        return new Response(JSON.stringify({
          error: {
            message: '缺少 API Key，请在请求头中提供 Authorization: Bearer <your-google-api-key>',
            type: 'invalid_request_error',
            code: 'missing_api_key',
          },
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
      return new Response(JSON.stringify(MODELS), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    // ── Responses API (Codex 客户端) ──
    if (pathname === '/v1/responses' && request.method === 'POST') {
      // ⚠️ 本分支会提前 return，不经过下面的通用限流 → 必须在这里单独限流。
      // 用 clone() 读取 body，避免消费掉 handleResponses 需要的原始请求体。
      let limitBody = null;
      try {
        limitBody = await request.clone().json();
      } catch {
        limitBody = {};
      }
      const limited = enforceRateLimits({
        reqId,
        clientIP,
        subject: rateLimitSubject,
        body: limitBody,
        modelId: extractModelId(limitBody),
        env,
        ctx,
        userAgent: request.headers.get('user-agent') || 'unknown',
        startTime,
        rpmLimit,
      });
      if (limited) {
        logRequest(reqId, request.method, pathname, 429, Date.now() - startTime, 'rate-limited');
        return limited;
      }
      logRequest(reqId, request.method, pathname, 200, 0, 'responses-api');
      return handleResponses(request, env);
    }
    if (pathname === '/v1/responses' && request.method === 'GET') {
      return new Response(JSON.stringify({ endpoint: '/v1/responses', methods: ['POST'], streaming: true }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    // ── Interactions API 直连 ──
    if (pathname === '/v1/interactions' && request.method === 'POST') {
      // ⚠️ 同 /v1/responses：本分支提前 return，需单独限流
      let limitBody = null;
      try {
        limitBody = await request.clone().json();
      } catch {
        limitBody = {};
      }
      const limited = enforceRateLimits({
        reqId,
        clientIP,
        subject: rateLimitSubject,
        body: limitBody,
        modelId: extractModelId(limitBody),
        env,
        ctx,
        userAgent: request.headers.get('user-agent') || 'unknown',
        startTime,
        rpmLimit,
      });
      if (limited) {
        logRequest(reqId, request.method, pathname, 429, Date.now() - startTime, 'rate-limited');
        return limited;
      }
      const authHeader = request.headers.get('authorization') || '';
      const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const inBody = await request.json();

      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['x-goog-api-key'] = apiKey;

      const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers,
        body: JSON.stringify(inBody),
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '{}');
        return new Response(errBody, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
      }

      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId, ...corsHeaders() },
      });
    }
    if (pathname === '/v1/interactions' && request.method === 'GET') {
      return new Response(JSON.stringify({ endpoint: '/v1/interactions', methods: ['POST'], note: 'Direct Interactions API passthrough. For Codex Responses API, use /v1/responses instead.' }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    // 限流检查（按 API Key 指纹归因，与 Vercel 端一致；无 Key → 不限流）
    if (rateLimitSubject && !rateLimiter.check(rateLimitSubject, rpmLimit)) {
      logRequest(reqId, request.method, pathname, 429, Date.now() - startTime, `rate-limited ${rateLimitSubject}`);
      // ⚠️ 限流拒绝也要计入遥测，否则 Dashboard 看不到被代理拦掉的请求
      recordRateLimitTelemetry({
        env, ctx, reqId,
        modelId: 'unknown-model',
        clientIP,
        userAgent: request.headers.get('user-agent') || 'unknown',
        startTime,
        reason: 'rpm_limit_exceeded',
      });
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
        // ⚠️ 鉴权统一走 header，绝不再把 Key 拼进 URL query。
        //    旧实现用 `?key=xxx`，会把完整 Key 带进日志/遥测/错误回显。
        //    Google 端点同时支持 `Authorization: Bearer` 与 `x-goog-api-key`。
        headers.set('authorization', `Bearer ${apiKey}`);
        headers.set('x-goog-api-key', apiKey);
      }
      // 脱敏后的 URL 仅用于日志输出，避免任何凭据进入日志系统
      const safeTargetUrl = redactUrl(targetUrl);
      logRequest(reqId, request.method, pathname, 0, 0, `→ ${safeTargetUrl}`);

      let body = null;
      let originalStreamRequested = false;
      let qclawCompatMode = false;
      let requestBodyText = null; // 保存原始请求体，供模型降级用
      let modelId = 'unknown'; // 用于遥测的模型 ID
      let inputTokens = 0; // TPM 遥测用：本次请求估计输入 token 数（CF 主流量）
      let qclawCompatStreamBody = null; // QClaw 兼容模式下改写的请求体（stream=false）
      const userAgent = request.headers.get('user-agent') || 'unknown';
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        try {
          const text = await request.text();
          requestBodyText = text;
          body = text && text.trim() !== '' ? text : '{}';

          if (isOpenAICompat) {
            const parsed = JSON.parse(body);
            if (parsed.stream === true) originalStreamRequested = true;
            if (parsed.model) modelId = parsed.model;
            body = sanitizeOpenAIBody(body);
            // ⚠️ 流式策略（与 Vercel 端完全一致）：
            //    · QClaw / WorkBuddy 客户端 → 改非流式发给 Google，取回完整 JSON 后手工拆成 SSE
            //    · 其它客户端 → 保留 stream=true，走真流式直通
            //    旧实现对所有客户端一律 stream=false，牺牲了普通客户端的实时性。
            if (originalStreamRequested) {
              qclawCompatMode = isQclawCompatClient(userAgent);
              if (qclawCompatMode) {
                const qclawParsed = JSON.parse(body);
                qclawParsed.stream = false;
                qclawCompatStreamBody = JSON.stringify(qclawParsed);
              }
            }
          }
        } catch {
          body = '{}';
        }
      }

      // 如果启用了 QClaw 兼容模式（stream=true → 非流式），用改写后的 body
      const fetchBody = qclawCompatStreamBody || body;

      // === TPM（每分钟输入 token）限流：根治 Google 免费层 16K 墙 ===
      // ⚠️ 归属主体用 API Key 指纹（与 Vercel 端一致），不再用客户端 IP ——
      //    否则同一用户换个出口 IP 就能绕过每分钟 token 墙。
      if (rateLimitSubject && isOpenAICompat && fetchBody && fetchBody !== '{}') {
        try {
          const parsedForTokens = JSON.parse(fetchBody);
          inputTokens = estimateInputTokens(parsedForTokens);
          const tpmRes = tokenRateLimiter.check(modelId, rateLimitSubject, inputTokens);
          if (!tpmRes.allowed) {
            logRequest(reqId, request.method, pathname, 429, Date.now() - startTime, `tpm-limited ${modelId} ~${inputTokens}tok`);
            // ⚠️ 限流拒绝也要计入遥测，否则 Dashboard 看不到被代理拦掉的请求
            recordRateLimitTelemetry({
              env, ctx, reqId,
              modelId,
              clientIP,
              userAgent,
              startTime,
              reason: `tpm_limit_exceeded (${tpmRes.limit}/min, need ${inputTokens})`,
            });
            return new Response(JSON.stringify({
              error: {
                message: `模型 ${modelId} 每分钟输入 token 上限为 ${tpmRes.limit}，本次请求约 ${inputTokens} token 会超出，请 ${tpmRes.retryAfter}s 后重试或换更大额度模型`,
                type: 'token_rate_limit_exceeded',
                code: 429,
                reqId
              }
            }), {
              status: 429,
              headers: { 'Content-Type': 'application/json', 'Retry-After': String(tpmRes.retryAfter), 'X-Request-Id': reqId, ...corsHeaders() }
            });
          }
        } catch {}
      }

      let response = await fetchWithRetry(targetUrl, {
        method: request.method,
        headers,
        body: fetchBody,
        cache: 'no-store',
      }, startTime);
      // 累计本次请求发生的重试次数（主请求 + 可能的降级请求），用于 Dashboard 「重试」统计
      let totalRetries = Number(response.retries) || 0;

      // === 模型降级：Google 429 token 配额 / 503 high demand / 524 源站超时 → 自动切换模型 ===
      if ((response.status === 429 || response.status === 500 || response.status === 503 || response.status === 524) && isOpenAICompat && requestBodyText) {
        let shouldFallback = false;
        if (response.status === 429) {
          shouldFallback = true; // token 配额 429 直接降级到更大额度模型（同模型重试已在 fetchWithRetry 完成）
        } else if (response.status === 524 || response.status === 500 || isHighDemand503(await response.clone().text())) {
          shouldFallback = true;
        }
        if (shouldFallback) {
          const originalModel = JSON.parse(requestBodyText).model;
          const fallbackModel = originalModel ? MODEL_FALLBACKS[originalModel] : null;
          if (fallbackModel) {
            const newBody = JSON.parse(fetchBody);
            newBody.model = fallbackModel;
            const fallbackResp = await fetchWithRetry(targetUrl, {
              method: request.method,
              headers,
              body: JSON.stringify(newBody),
              cache: 'no-store',
            }, startTime);
            totalRetries += Number(fallbackResp.retries) || 0;
            logRequest(reqId, request.method, pathname, fallbackResp.status, Date.now() - startTime,
              `fallback ${originalModel} → ${fallbackModel}`);
            if (fallbackResp.status !== 500 && fallbackResp.status !== 503 && fallbackResp.status !== 524 && fallbackResp.status !== 429) {
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
      // ⚠️ 遥测事件统一收敛到 lib/telemetry.js（与 Vercel 端共用同一份实现）：
      //    · 补齐此前「只有读取方、没有写入方」的 latencySum / latencyCount /
      //      clients:{date}:* / client:info:* → Dashboard 的平均延迟与客户端面板不再恒空
      //    · status / timeline / recent / errors / quota / tpm / retries / slow 的 key 与口径两端一致
      const date = getQuotaDate();
      const bjHour = getBeijingHour();
      const finalModelId = modelId === 'unknown' ? 'unknown-model' : modelId;
      const nowMs = Date.now();
      const latency = nowMs - startTime;
      const ua = userAgent;

      // 客户端指纹：API Key → 稳定短哈希（与 Vercel 端共用 lib/rate-limit.js 的实现）
      let clientFingerprint = '';
      try {
        const authForFp = request.headers.get('authorization') || '';
        if (authForFp.startsWith('Bearer ')) {
          clientFingerprint = await computeClientFingerprint(authForFp.slice(7).trim());
        }
      } catch {
        clientFingerprint = '';
      }

      const telemetryEvents = buildTelemetryEvents({
        date,
        hour: bjHour,
        status: response.status,
        model: finalModelId,
        latency,
        ua,
        ip: clientIP,
        fingerprint: clientFingerprint,
        inputTokens,
        totalRetries,
      });
      const telemetryCmds = telemetryEventsToUpstashCommands(telemetryEvents);
      ctx.waitUntil(upstashPipe(env, telemetryCmds));

      const respHeaders = buildResponseHeaders(response);
      respHeaders.set('X-Request-Id', reqId);
      respHeaders.set('X-Proxy', 'cloudflare-workers');

      // ═══════════════════════════════════════════════════════
      // QClaw 兼容模式：客户端请求 stream=true，但已改为非流式发给 Google
      // 收到完整 JSON 后，手动拆分为 SSE chunks
      // ⚠️ 拆分实现已收敛到 lib/chat-stream.js（与 Vercel 端共用同一份）
      // ═══════════════════════════════════════════════════════
      if (originalStreamRequested && qclawCompatMode && response.ok) {
        try {
          const responseText = await response.text();
          const responseData = responseText ? JSON.parse(responseText) : null;
          if (responseData && responseData.choices && responseData.choices[0] && responseData.choices[0].message) {
            const chunks = buildChatCompletionChunks(responseData);
            chunks.push(SSE_DONE);
            const qclawHeaders = new Headers({
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-Accel-Buffering': 'no',
              'X-Request-Id': reqId,
              'X-Proxy': 'cloudflare-workers',
              ...corsHeaders(),
            });
            logRequest(reqId, request.method, pathname, 200, Date.now() - startTime, 'qclaw-compat');
            return new Response(chunks.join(''), {
              status: 200,
              headers: qclawHeaders,
            });
          }
        } catch (e) {
          console.error(`[${reqId}] QClaw compat error: ${e.message}`);
          // fall through to normal handling
        }
      }

      const upstreamBody = response.body;
      const contentType = response.headers.get('content-type') || '';

      // --- 情况 1: 正常流式响应 ---
      // ⚠️ 直通 + <thought> 剥离的实现已收敛到 lib/chat-stream.js（与 Vercel 端共用同一份）
      if (upstreamBody && (contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson'))) {
        // 确保 SSE 响应头完整
        if (!respHeaders.has('Cache-Control') || respHeaders.get('Cache-Control') === 'no-store') {
          respHeaders.set('Cache-Control', 'no-cache');
        }
        respHeaders.set('X-Accel-Buffering', 'no');
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        let aborted = false;

        const streamPromise = (async () => {
          const encoder = new TextEncoder();
          try {
            // ⚠️ 共享实现：跨 SSE 事件的 <thought> / <|thought> 状态机 +
            //    结束时补齐 finish_reason（避免客户端 "empty stream"）
            for await (const piece of transformUpstreamSSE(upstreamBody, { reqId })) {
              if (aborted) break;
              await writer.write(encoder.encode(piece));
            }
            await writer.write(encoder.encode(SSE_DONE));
          } catch (err) {
            console.error(`[${reqId}] Stream error: ${err.message}`);
          } finally {
            await writer.close().catch(() => {});
          }
        })();
        // ⚠️ ctx.waitUntil 返回 void！不能链式 .catch()，必须先保存 promise 变量
        streamPromise.catch(err => console.error(`[${reqId}] ctx.waitUntil error: ${err.message}`));
        ctx.waitUntil(streamPromise);

        request.signal.addEventListener('abort', () => {
          aborted = true;
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

        const sseHeaders = new Headers(respHeaders);
        sseHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
        sseHeaders.set('Cache-Control', 'no-cache');
        sseHeaders.set('Connection', 'keep-alive');

        logRequest(reqId, request.method, pathname, response.status, Date.now() - startTime, 'error-sse');
        return new Response(buildSseError(response.status, errorMsg, reqId), {
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
