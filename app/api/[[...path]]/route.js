// app/api/[[...path]]/route.js
// Gemini 透明代理 - 鲁棒增强版 (带智能重试与遥测统计)
import { HIGH_QUOTA_MODELS } from '../../../lib/models';
import { getQuotaDate } from '../../../lib/utils';
import { getRedis } from '../../../lib/redis';

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';

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
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return undefined;
  return await req.text();
}

function cleanHeaders(headers) {
  const clean = new Headers();
  for (const [key, value] of headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
      clean.set(key, value);
    }
  }
  return clean;
}

// Google Gemini OpenAI-compatible API 不支持的字段黑名单
// 这些字段会被剥离后再转发给 Google API
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
]);

// Google API 不支持 OpenAI 的某些参数，转发前清理掉
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
  } catch (e) {
    // 非 JSON body 直接透传
    return body;
  }
}

function buildTargetUrl(pathname, search) {
  const rules = [
    { prefix: '/api/v1/', replacement: '/v1beta/openai/' },
    { prefix: '/v1/', replacement: '/v1beta/openai/' },
    // 不再盲目映射 /api/ → /，避免构造出无效 URL
  // 标准路径如 /api/v1/ 和 /v1/ 已由前两条规则覆盖
  ];
  let targetPath = pathname;
  for (const { prefix, replacement } of rules) {
    if (targetPath.startsWith(prefix)) {
      targetPath = replacement + targetPath.slice(prefix.length);
      break;
    }
  }
  // 不过滤 query params — Google 会忽略不认识的参数
  // 之前白名单太严导致 model 等字段被误杀，引发 400
  if (search) {
    return `${GOOGLE_API_BASE}${targetPath}${search}`;
  }
  return `${GOOGLE_API_BASE}${targetPath}`;
}

// CORS 来源控制：配置 CORS_ALLOWED_ORIGINS 环境变量后仅允许白名单域名
// 未配置时保持向后兼容，允许所有来源（*）
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
 };
}

function buildResponseHeaders(response, req, reqId = '') {
 const headers = new Headers();
 for (const [key, value] of response.headers.entries()) {
 if (!BLOCKED_RESPONSE_HEADERS.includes(key.toLowerCase())) {
 headers.set(key, value);
 }
 }
 const cors = getCorsHeaders(req);
 for (const [k, v] of Object.entries(cors)) {
 headers.set(k, v);
 }
 if (reqId) headers.set('X-Request-Id', reqId);
 return headers;
}

// 智能重试：仅对可重试的 502/503 重试，504 不重试（超时重试只会更慢）
// 最大 2 次，backoff 0.5s, 1s
const RETRYABLE_STATUSES = new Set([502, 503]);

async function fetchWithRetry(url, options, maxAttempts = 2) {
  let lastError;
  let retries = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, options);
      if (RETRYABLE_STATUSES.has(response.status)) {
        console.warn(`[FetchRetry] Attempt ${attempt} got ${response.status}. Retrying...`);
        retries++;
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, attempt * 500));
          continue;
        }
      }
      response._retries = retries;
      return response;
    } catch (error) {
      lastError = error;
      retries++;
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw lastError || new Error('Max retry attempts reached');
}

async function handleRequest(req) {
 const startTime = Date.now();
 // 请求级日志 ID：8 位 hex，方便追踪单次请求全链路
 const reqId = Date.now().toString(16).slice(-6) + Math.random().toString(16).slice(2, 6);
 
 // 提取客户端信息
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

    let targetUrl = buildTargetUrl(pathname, search);
    const headers = cleanHeaders(req.headers);

    const isOpenAICompat = targetUrl.includes('/v1beta/openai/');
    const authHeader = req.headers.get('authorization') || '';
    let clientFingerprint = 'anon';
    let apiKey = '';
    if (authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.slice(7).trim();
    if (!isOpenAICompat) {
      // Google 原生 API：用 ?key= 传 API Key
      const urlWithKey = new URL(targetUrl);
      urlWithKey.searchParams.set('key', apiKey);
      targetUrl = urlWithKey.toString();
      headers.delete('authorization');
    }
    // OpenAI 兼容路径：保留 Authorization 头，不拼接 ?key=，避免双重认证
    // 来源指纹（提前计算，限流也用）
    try {
    const keyData = new TextEncoder().encode(apiKey);
    const hashBuf = await crypto.subtle.digest('SHA-1', keyData);
    const hashArr = Array.from(new Uint8Array(hashBuf));
    clientFingerprint = hashArr.slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {}
    }

    // 获取 Redis 实例（如果环境变量缺失则返回 null）
    const redis = getRedis();

    // ---- 限流：每指纹 60 秒窗口内最多 RATE_LIMIT_RPM 次请求 ----
    const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '10', 10);
    if (RATE_LIMIT_RPM > 0 && clientFingerprint !== 'anon' && redis) {
    const now = Math.floor(Date.now() / 1000);
    const windowKey = `ratelimit:${clientFingerprint}:${now}`;
    const count = await redis.incr(windowKey);
    if (count === 1) {
    await redis.expire(windowKey, 120); // 最多保留 2 分钟
    }
    if (count > RATE_LIMIT_RPM) {
    console.warn(`[${reqId}] Rate Limit: ${clientFingerprint} exceeded ${RATE_LIMIT_RPM} RPM (current: ${count})`);
    return new Response(JSON.stringify({
    error: {
    message: `请求过于频繁，每分钟最多 ${RATE_LIMIT_RPM} 次，请稍后重试`,
    type: 'rate_limit_exceeded',
    code: 429
    }
    }), {
    status: 429,
    headers: {
    'Content-Type': 'application/json',
    'Retry-After': '60',
    ...getCorsHeaders(req),
    }
    });
    }
    }

    const body = await getRequestBody(req);

    let modelId = 'unknown';
    if (body) {
      try {
        const json = JSON.parse(body);
        if (json.model) modelId = json.model;
      } catch (e) {}
    }
    if (modelId === 'unknown') {
      // 尝试从 URL 路径提取（如 /v1/models/gemma-4-31b-it）
      const modelMatch = targetUrl.match(/\/models\/([^/:]+)/);
      if (modelMatch && modelMatch[1]) {
        modelId = modelMatch[1];
      } else {
        // 尝试从 query string 提取（如 ?model=gemma-4-31b-it）
        try {
          const urlObj = new URL(targetUrl);
          const queryModel = urlObj.searchParams.get('model');
          if (queryModel) modelId = queryModel;
        } catch {}
      }
    }

    // OpenAI 兼容路径下过滤 reasoning_effort，避免 Google API 报 400
    const sanitizedBody = isOpenAICompat ? sanitizeOpenAIBody(body) : body;

    const response = await fetchWithRetry(targetUrl, {
      method: req.method,
      headers: headers,
      body: sanitizedBody,
      cache: 'no-store',
    });

    const latency = Date.now() - startTime;
    const date = getQuotaDate();
    const finalModelId = modelId === 'unknown' ? 'unknown-model' : modelId;

  // 北京时间整点小时 (0-23)，用于时间线分桶
  const bjHour = (new Date().getUTCHours() + 8) % 24;

  // 来源统计：clientFingerprint 已在上方限流逻辑中计算

  // 48h TTL：遥测数据按日期分桶，隔天仍可查看，两天后自动清理
  const TTL = 48 * 60 * 60; // 48 小时（秒）

  // 将遥测写入从 pipeline 改为 Promise.all 单独写入
  // Upstash Redis 的 auto-pipelining 会自动合并这些请求
  const telemetryOps = redis ? [
      redis.incr(`quota:${date}:${finalModelId}`).then(() => redis.expire(`quota:${date}:${finalModelId}`, TTL)),
      redis.incr(`quota:global:${date}`).then(() => redis.expire(`quota:global:${date}`, TTL)),
      redis.incr('proxy:heartbeat'),
      redis.incr(`status:${date}:${response.status}`).then(() => redis.expire(`status:${date}:${response.status}`, TTL)),
      redis.lpush(`latency:${finalModelId}`, latency).then(() => redis.ltrim(`latency:${finalModelId}`, 0, 99)).then(() => redis.expire(`latency:${finalModelId}`, TTL)),
      redis.incr(`timeline:${date}:h${bjHour}`).then(() => redis.expire(`timeline:${date}:h${bjHour}`, TTL)),
      redis.sadd(`timeline:${date}:hours`, `h${bjHour}`).then(() => redis.expire(`timeline:${date}:hours`, TTL)),
      redis.incr(`clients:${date}:${clientFingerprint}`).then(() => redis.expire(`clients:${date}:${clientFingerprint}`, TTL)),
      redis.sadd(`clients:${date}:keys`, clientFingerprint).then(() => redis.expire(`clients:${date}:keys`, TTL)),
      // 记录客户端详细信息（IP、UA、最后 seen 时间）
      redis.hset(`client:info:${clientFingerprint}`, {
        ip: clientIP,
        ua: userAgent,
        lastSeen: new Date().toISOString(),
      }).then(() => redis.expire(`client:info:${clientFingerprint}`, TTL)),
    ] : [];

    // 重试计数
    const retries = response._retries || 0;
    if (retries > 0 && redis) {
    telemetryOps.push(redis.incr(`retries:${date}`).then(() => redis.expire(`retries:${date}`, TTL)));
    }

    // 最近请求摘要
    const recentEntry = JSON.stringify({
    ts: new Date().toISOString(),
    reqId,
    model: finalModelId,
    status: response.status,
    latency: latency,
    retries: retries,
    client: clientFingerprint,
    ip: clientIP,
    ua: userAgent,
    });
    if (redis) {
    telemetryOps.push(
    redis.lpush(`recent:${date}`, recentEntry).then(() => redis.ltrim(`recent:${date}`, 0, 49)).then(() => redis.expire(`recent:${date}`, TTL))
    );
    }
    
    // 慢请求追踪：延迟 >3000ms 的记录到 sorted set
    if (latency > 3000 && redis) {
    telemetryOps.push(
    redis.zadd(`slow:${date}`, latency, recentEntry)
    .then(() => redis.zremrangebyrank(`slow:${date}`, 0, -11)) // 只保留 Top 10
    .then(() => redis.expire(`slow:${date}`, TTL))
    );
    }

    // 错误日志：4xx/5xx 写入 Redis List
    if (response.status >= 400 && redis) {
    const errorEntry = JSON.stringify({
    ts: new Date().toISOString(),
    reqId,
    model: finalModelId,
    status: response.status,
    latency: latency,
    ip: clientIP,
    ua: userAgent,
    });
    telemetryOps.push(
    redis.lpush(`errors:${date}`, errorEntry).then(() => redis.ltrim(`errors:${date}`, 0, 99)).then(() => redis.expire(`errors:${date}`, TTL))
    );
    }

    // 增量更新平均延迟
    if (redis) {
    (async () => {
    try {
    const existing = await redis.get(`avgLatency:${date}:${finalModelId}`);
    let count = 0, avg = latency;
    if (existing && typeof existing === 'string') {
    const parts = existing.split(':');
    const prevCount = parseInt(parts[0]) || 0;
    const prevAvg = parseInt(parts[1]) || latency;
    count = prevCount + 1;
    avg = Math.round((prevAvg * prevCount + latency) / count);
    } else {
    count = 1;
    }
    await redis.set(`avgLatency:${date}:${finalModelId}`, `${count}:${avg}`, { ex: TTL });
    } catch (e) {
    console.error(`[AvgLatency Error] ${e}`);
    }
    })();
    }

 // 遥测 fire-and-forget：不阻塞响应返回
 // Edge Runtime 在返回 Response 后会给异步操作足够时间完成
 const telemetryPromise = Promise.all(telemetryOps).catch(err => console.error(`[Redis Telemetry Error] ${err}`));

    // 流式响应：检测客户端断线，中止上游读取
    const upstreamBody = response.body;
    if (upstreamBody && response.headers.get('content-type')?.includes('text/event-stream')) {
    // SSE 流式：不 await 遥测，fire-and-forget，避免阻塞 first byte
    // Edge Runtime 在返回 Response 后不会立即冻结，遥测有足够时间完成
    telemetryPromise;
    const transformed = new ReadableStream({
    start(controller) {
    const reader = upstreamBody.getReader();
    let aborted = false;
    const pump = () => {
    if (aborted) return;
    reader.read().then(({ done, value }) => {
    if (done) { controller.close(); return; }
    controller.enqueue(value);
    pump();
    }).catch(err => {
    // 上游读取错误（如服务端断线），如果客户端已断线则静默处理
    if (!aborted) {
    console.error(`[${reqId}] Upstream read error: ${err.message}`);
    try { controller.error(err); } catch {}
    }
    });
    };
    pump();

    // 客户端断线时中止上游读取
    req.signal.addEventListener('abort', () => {
    aborted = true;
    console.warn(`[${reqId}] Client disconnected, cancelling upstream`);
    reader.cancel().catch(() => {});
    try { controller.close(); } catch {}
    });
    },
    });
    return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: buildResponseHeaders(response, req, reqId),
    });
    }

    // 非流式响应：fire-and-forget 遥测，不阻塞响应返回
    telemetryPromise;
    let finalBody = upstreamBody || null;
    // Google 有时对 4xx/5xx 返回空 body，客户端看到 "no body"
    // 这种情况下补一个结构化错误体，方便客户端诊断
    if (!finalBody && response.status >= 400) {
      finalBody = JSON.stringify({
        error: {
          message: `Upstream returned HTTP ${response.status}`,
          type: 'upstream_error',
          code: response.status,
          reqId
        }
      });
    }
    return new Response(finalBody, {
    status: response.status,
    statusText: response.statusText,
    headers: buildResponseHeaders(response, req, reqId),
    });
  } catch (error) {
  console.error(`[${reqId}] Proxy Error:`, error);
  // 生产环境脱敏：不暴露内部错误细节，仅返回通用信息
  const isDev = process.env.NODE_ENV === 'development';
  const userMessage = isDev
  ? `Proxy Error: ${error.message}`
  : '代理请求失败，请稍后重试';
  return new Response(JSON.stringify({
  error: {
  message: userMessage,
  type: 'proxy_error',
  code: 502,
  reqId
  }
  }), {
  status: 502,
  headers: {
  'Content-Type': 'application/json',
  'X-Request-Id': reqId,
  ...getCorsHeaders(req),
  }
  });
  }
}

export const runtime = 'nodejs';
export const maxDuration = 60; // Hobby 上限 60s，Pro 上限 300s
export async function GET(req) { return handleRequest(req); }
export async function POST(req) { return handleRequest(req); }
export async function PUT(req) { return handleRequest(req); }
export async function DELETE(req) { return handleRequest(req); }
export async function OPTIONS(req) {
 return new Response(null, {
 status: 204,
 headers: getCorsHeaders(req),
 });
}