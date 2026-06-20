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
 * 或绑定自定义域名后保持 https://api.170909.xyz/v1/...
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
      limit: 1500,
      description: 'Gemma 4 31B (Dense) — 1,500 req/day | 256K ctx ⭐ 主力',
    },
    {
      id: 'gemma-4-26b-a4b-it',
      object: 'model',
      created: 1743561600,
      owned_by: 'google',
      limit: 1500,
      description: 'Gemma 4 26B A4B (MoE) — 1,500 req/day | 256K ctx',
    },
  ],
};

// ============================================================
// 工具函数
// ============================================================

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
  // 注意: CF Workers 的 query string 包含 ? 前缀
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
function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
  };
}

/** 智能重试：仅对可重试的 502/503 重试，backoff 0.5s, 1s */
const RETRYABLE = new Set([502, 503]);

async function fetchWithRetry(url, options, maxAttempts = 2) {
  const startTime = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, options);
      if (RETRYABLE.has(response.status) && attempt < maxAttempts) {
        const elapsed = Date.now() - startTime;
        if (elapsed > 25000) {
          console.warn(`[FetchRetry] Attempt ${attempt} got ${response.status}, but elapsed ${elapsed}ms > threshold. Skipping retry.`);
          return response;
        }
        console.warn(`[FetchRetry] Attempt ${attempt} got ${response.status}. Retrying...`);
        await new Promise((r) => setTimeout(r, attempt * 500));
        continue;
      }
      return response;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      if (attempt < maxAttempts && elapsed < 25000) {
        console.warn(`[FetchRetry] Attempt ${attempt} error: ${error.message}. Retrying...`);
        await new Promise((r) => setTimeout(r, attempt * 500));
        continue;
      }
      throw error;
    }
  }
}

// ============================================================
// 主入口
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, search } = url;
    const startTime = Date.now();
    const reqId =
      Date.now().toString(16).slice(-6) +
      Math.random().toString(16).slice(2, 6);

    console.log(`[${reqId}] ${request.method} ${pathname}${search}`);

    // ---------- OPTIONS (预检) ----------
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(),
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
          ...getCorsHeaders(),
        },
      });
    }

    try {
      // ---------- 构建上游 URL ----------
      let targetUrl = buildTargetUrl(pathname, search);

      // ---------- 注入 API Key（Bearer → ?key=） ----------
      const authHeader = request.headers.get('authorization') || '';
      if (authHeader.startsWith('Bearer ')) {
        const apiKey = authHeader.slice(7).trim();
        const urlWithKey = new URL(targetUrl);
        urlWithKey.searchParams.set('key', apiKey);
        targetUrl = urlWithKey.toString();
      }

      // ---------- 清理请求头 ----------
      const headers = cleanHeaders(request.headers);

      // ---------- 读取并过滤请求体 ----------
      let body = null;
      const isOpenAI = targetUrl.includes('/v1beta/openai/');

      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        try {
          const text = await request.text();
          body = (text && text.trim() !== '') ? text : '{}';
        } catch (e) {
          body = '{}';
        }
        if (isOpenAI) {
          body = sanitizeOpenAIBody(body);
        }
      }

      // ---------- 转发请求 ----------
      const response = await fetchWithRetry(targetUrl, {
        method: request.method,
        headers,
        body,
      });

      const latency = Date.now() - startTime;
      console.log(
        `[${reqId}] → ${response.status} (${latency}ms)` +
          (response._retries ? `, retries=${response._retries}` : '')
      );

      // ---------- 构建响应 ----------
      const respHeaders = new Headers();

      // 透传上游响应头（移除 blocklist）
      for (const [key, value] of response.headers.entries()) {
        const k = key.toLowerCase();
        if (
          !['content-encoding', 'transfer-encoding', 'connection'].includes(k)
        ) {
          respHeaders.set(key, value);
        }
      }

      // 添加 CORS 头
      const cors = getCorsHeaders();
      for (const [k, v] of Object.entries(cors)) {
        respHeaders.set(k, v);
      }

      respHeaders.set('X-Request-Id', reqId);
      respHeaders.set('X-Proxy', 'cloudflare-workers');

      // 流式和非流式统一透传 body
      return new Response(response.body, {
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
            ...getCorsHeaders(),
          },
        }
      );
    }
  },
};
