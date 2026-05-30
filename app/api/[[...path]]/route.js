// app/api/[[...path]]/route.js
// Gemini 透明代理 - 鲁棒增强版 (带智能重试与遥测统计)
import { HIGH_QUOTA_MODELS } from '../../../lib/models';
import { getQuotaDate } from '../../../lib/utils';
import redis from '../../../lib/redis';

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

function buildTargetUrl(pathname, search) {
  const rules = [
    { prefix: '/api/v1/', replacement: '/v1beta/openai/' },
    { prefix: '/v1/', replacement: '/v1beta/openai/' },
    { prefix: '/api/', replacement: '/' },
  ];
  let targetPath = pathname;
  for (const { prefix, replacement } of rules) {
    if (targetPath.startsWith(prefix)) {
      targetPath = replacement + targetPath.slice(prefix.length);
      break;
    }
  }
  if (search) {
    const params = new URLSearchParams(search);
    const allowed = ['alt', 'prettyPrint', 'fields', 'quotaUser', 'userIp'];
    const filtered = new URLSearchParams();
    for (const [k, v] of params) {
      if (allowed.includes(k)) filtered.set(k, v);
    }
    const filteredStr = filtered.toString();
    return `${GOOGLE_API_BASE}${targetPath}${filteredStr ? '?' + filteredStr : ''}`;
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

async function fetchWithRetry(url, options, maxAttempts = 3) {
  let lastError;
  let retries = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status >= 500 && response.status <= 599) {
        console.warn(`[${reqId}] Attempt ${attempt} failed with status ${response.status}. Retrying...`);
        retries++;
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, attempt * 1000));
          continue;
        }
      }
      response._retries = retries;
      return response;
    } catch (error) {
      lastError = error;
      retries++;
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  throw lastError || new Error('Max retry attempts reached');
}

async function handleRequest(req) {
 const startTime = Date.now();
 // 请求级日志 ID：8 位 hex，方便追踪单次请求全链路
 const reqId = Date.now().toString(16).slice(-6) + Math.random().toString(16).slice(2, 6);
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
    if (authHeader.startsWith('Bearer ')) {
    const apiKey = authHeader.slice(7).trim();
    const urlWithKey = new URL(targetUrl);
    urlWithKey.searchParams.set('key', apiKey);
    targetUrl = urlWithKey.toString();
    if (!isOpenAICompat) {
    headers.delete('authorization');
    }
    // 来源指纹（提前计算，限流也用）
    try {
    const keyData = new TextEncoder().encode(apiKey);
    const hashBuf = await crypto.subtle.digest('SHA-1', keyData);
    const hashArr = Array.from(new Uint8Array(hashBuf));
    clientFingerprint = hashArr.slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {}
    }

    // ---- 限流：每指纹 60 秒窗口内最多 RATE_LIMIT_RPM 次请求 ----
    const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '10', 10);
    if (RATE_LIMIT_RPM > 0 && clientFingerprint !== 'anon') {
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
      const modelMatch = targetUrl.match(/\/models\/([^/:]+)/);
      if (modelMatch && modelMatch[1]) {
        modelId = modelMatch[1];
      }
    }

    const response = await fetchWithRetry(targetUrl, {
      method: req.method,
      headers: headers,
      body: body,
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

  const pipeline = redis.pipeline();
  pipeline.incr(`quota:${date}:${finalModelId}`);
  pipeline.expire(`quota:${date}:${finalModelId}`, TTL);
  pipeline.incr(`quota:global:${date}`);
  pipeline.expire(`quota:global:${date}`, TTL);
  pipeline.incr('proxy:heartbeat');
  pipeline.incr(`status:${date}:${response.status}`);
  pipeline.expire(`status:${date}:${response.status}`, TTL);
  pipeline.lpush(`latency:${finalModelId}`, latency);
  pipeline.ltrim(`latency:${finalModelId}`, 0, 99);
  pipeline.expire(`latency:${finalModelId}`, TTL);
  // 时间线分桶
  pipeline.incr(`timeline:${date}:h${bjHour}`);
  pipeline.expire(`timeline:${date}:h${bjHour}`, TTL);
  pipeline.sadd(`timeline:${date}:hours`, `h${bjHour}`);
  pipeline.expire(`timeline:${date}:hours`, TTL);
  // 来源统计
  pipeline.incr(`clients:${date}:${clientFingerprint}`);
  pipeline.expire(`clients:${date}:${clientFingerprint}`, TTL);
  pipeline.sadd(`clients:${date}:keys`, clientFingerprint);
  pipeline.expire(`clients:${date}:keys`, TTL);

  // 重试计数
  const retries = response._retries || 0;
  if (retries > 0) {
  pipeline.incr(`retries:${date}`);
  pipeline.expire(`retries:${date}`, TTL);
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
  });
  pipeline.lpush(`recent:${date}`, recentEntry);
  pipeline.ltrim(`recent:${date}`, 0, 49);
  pipeline.expire(`recent:${date}`, TTL);

  // 错误日志：4xx/5xx 写入 Redis List
  if (response.status >= 400) {
  const errorEntry = JSON.stringify({
  ts: new Date().toISOString(),
  reqId,
  model: finalModelId,
  status: response.status,
  latency: latency,
  });
  pipeline.lpush(`errors:${date}`, errorEntry);
  pipeline.ltrim(`errors:${date}`, 0, 99);
  pipeline.expire(`errors:${date}`, TTL);
  }

  // 增量更新平均延迟（在 pipeline 外单独处理，避免依赖 pipeline 索引）
 redis.get(`avgLatency:${date}:${finalModelId}`).then(existing => {
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
 redis.set(`avgLatency:${date}:${finalModelId}`, `${count}:${avg}`, { ex: TTL }).catch(() => {});
 }).catch(() => {});

 pipeline.exec().catch(err => console.error(`[Redis Telemetry Error] ${err}`));

    // 流式响应：检测客户端断线，中止上游读取
    const upstreamBody = response.body;
    if (upstreamBody && response.headers.get('content-type')?.includes('text/event-stream')) {
    // SSE 流式：包装 ReadableStream，监听客户端断线
    const transformed = new ReadableStream({
    start(controller) {
    const reader = upstreamBody.getReader();
    const pump = () => {
    reader.read().then(({ done, value }) => {
    if (done) { controller.close(); return; }
    controller.enqueue(value);
    pump();
    }).catch(err => {
    // 上游读取错误（如服务端断线）
    console.error(`[${reqId}] Upstream read error: ${err.message}`);
    controller.error(err);
    });
    };
    pump();

    // 客户端断线时中止上游读取
    req.signal.addEventListener('abort', () => {
    console.warn(`[${reqId}] Client disconnected, cancelling upstream`);
    reader.cancel().catch(() => {});
    controller.close();
    });
    },
    });
    return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: buildResponseHeaders(response, req, reqId),
    });
    }

    return new Response(upstreamBody || null, {
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

export const runtime = 'edge';
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
