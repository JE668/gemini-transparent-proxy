// app/api/[[...path]]/route.js
// Gemini 透明代理 - 纯转发稳定版（带 Redis 计数统计）
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

// ======================= 主处理器 =======================
async function handleRequest(req) {
  try {
    const url = new URL(req.url);
    const { pathname, search } = url;
    console.log(`[Proxy] ${req.method} ${pathname}`);

    // 处理 /v1/models 请求
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

    // 认证桥接：将 Authorization: Bearer 转为 URL 参数 ?key=
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

    // 记录配额使用量 (Redis)
    let modelId = 'unknown';
    
    // 1. 尝试从请求体提取 (OpenAI 格式)
    if (body) {
      try {
        const json = JSON.parse(body);
        if (json.model) modelId = json.model;
      } catch (e) {}
    }

    // 2. 如果请求体没找到，尝试从 URL 提取 (Google 原生格式)
    // 匹配 /v1beta/models/{model}:generateContent 或类似路径
    if (modelId === 'unknown') {
      const modelMatch = targetUrl.match(/\/models\/([^\/:]+)/);
      if (modelMatch && modelMatch[1]) {
        modelId = modelMatch[1];
      }
    }

    // 直接转发请求，不使用任何 TransformStream
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: body,
      cache: 'no-store',
    });

    // 如果请求成功，必须记录到 Redis (无论模型是否识别成功)
    if (response.ok) {
      const date = getQuotaDate();
      const finalModelId = modelId === 'unknown' ? 'unknown-model' : modelId;
      
      try {
        // 强制执行，确保在 Upstash 面板能看到命令增加
        await Promise.all([
          redis.incr(`quota:${date}:${finalModelId}`),
          redis.incr(`quota:global:${date}`),
          redis.incr(`proxy:heartbeat`) // 全局心跳，用于排除连接问题
        ]);
      } catch (err) {
        console.error(`[Redis Error] ${err}`);
      }
    }

    console.log(`[Proxy] Response status: ${response.status} | Model: ${modelId}`);

    // 原样返回响应体
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

// ======================= Edge Runtime & 导出 =======================
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
