// app/api/[[...path]]/route.js
// Gemini 透明代理 - 鲁棒增强版 (带智能重试与遥测统计)
import { Redis } from '@upstash/redis';
import { HIGH_QUOTA_MODELS } from '../../../lib/models';
import { getQuotaDate } from '../../../lib/utils';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';

// ======================= 常量定义 =======================
const HOP_BY_HOP_HEADERS = [
  'host', 'connection', 'keep-alive', 'proxy-authorization',
  'proxy-authenticate', 'te', 'trailers', 'transfer-encoding',
  'upgrade', 'content-length'
];

const BLOCKED_RESPONSE_HEADERS = [
  'content-encoding', 'transfer-encoding', 'connection',
  'keep-alive', 'strict-transport-security'
];

// ======================= 辅助函数 =======================
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

function buildResponseHeaders(response) {
  const headers = new Headers();
  for (const [key, value] of response.headers.entries()) {
    if (!BLOCKED_RESPONSE_HEADERS.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', '*');
  return headers;
}

// ======================= 智能重试逻辑 =======================
async function fetchWithRetry(url, options, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, options);
      
      // 只有 5xx 错误才触发重试
      if (response.status >= 500 && response.status <= 599) {
        console.warn(`[Proxy] Attempt ${attempt} failed with status ${response.status}. Retrying...`);
        if (attempt < maxAttempts) {
          // 指数退避: 1s, 2s
          await new Promise(resolve => setTimeout(resolve, attempt * 1000));
          continue;
        }
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  throw lastError || new Error('Max retry attempts reached');
}

// ======================= 主处理器 =======================
async function handleRequest(req) {
  const startTime = Date.now();
  try {
    const url = new URL(req.url);
    const { pathname, search } = url;

    if (pathname.endsWith('/models') || pathname.includes('/v1/models') || pathname.includes('/v1beta/openai/models')) {
      return new Response(JSON.stringify({ object: 'list', data: HIGH_QUOTA_MODELS }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }

    let targetUrl = buildTargetUrl(pathname, search);
    const headers = cleanHeaders(req.headers);

    const isOpenAICompat = targetUrl.includes('/v1beta/openai/');
    const authHeader = req.headers.get('authorization') || '';
    if (authHeader.startsWith('Bearer ')) {
      const apiKey = authHeader.slice(7).trim();
      const urlWithKey = new URL(targetUrl);
      urlWithKey.searchParams.set('key', apiKey);
      targetUrl = urlWithKey.toString();
      if (!isOpenAICompat) {
        headers.delete('authorization');
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
      const modelMatch = targetUrl.match(/\\/models\\/([^\\/:]+)/);
      if (modelMatch && modelMatch[1]) {
        modelId = modelMatch[1];
      }
    }

    // 使用智能重试机制发起请求
    const response = await fetchWithRetry(targetUrl, {
      method: req.method,
      headers: headers,
      body: body,
      cache: 'no-store',
    });

    const latency = Date.now() - startTime;
    const date = getQuotaDate();
    const finalModelId = modelId === 'unknown' ? 'unknown-model' : modelId;

    // 异步记录详细遥测数据
    Promise.all([
      redis.incr(`quota:${date}:${finalModelId}`),
      redis.incr(`quota:global:${date}`),
      redis.incr(`proxy:heartbeat`),
      // 记录状态码分布
      redis.incr(`status:${date}:${response.status}`),
      // 记录延迟 (使用 Redis 列表存储最近 100 次延迟，用于计算平均值)
      redis.lpush(`latency:${finalModelId}`, latency),
      redis.ltrim(`latency:${finalModelId}`, 0, 99),
    ]).catch(err => console.error(`[Redis Telemetry Error] ${err}`));

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: buildResponseHeaders(response),
    });
  } catch (error) {
    console.error('[Proxy] Error:', error);
    return new Response(JSON.stringify({
      error: {
        message: `Proxy Error: ${error.message}`,
        type: 'proxy_error',
        code: 502
      }
    }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
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
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  });
}
