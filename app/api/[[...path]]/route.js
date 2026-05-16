// app/api/[[...path]]/route.js
// Gemini 透明代理 - 纯转发稳定版（无 TransformStream，无统计解析）
const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';

// ======================= 模型列表（基于官方免费层配额 2026-05）=======================
const HIGH_QUOTA_MODELS = [
  // ---------- Gemma 4 系列 (高配额, 1,500 req/day, 15 RPM) ----------
  {
    id: 'gemma-4-31b-it',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    description: 'Gemma 4 31B (Dense) — 1,500 req/day (15 RPM) | 256K ctx ⭐ 主力'
  },
  {
    id: 'gemma-4-26b-a4b-it',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    description: 'Gemma 4 26B A4B (MoE) — 1,500 req/day (15 RPM) | 256K ctx'
  },

  // ---------- Gemma 3 系列 (14,400 req/day, 30 RPM) ----------
  {
    id: 'gemma-3-27b-it',
    object: 'model',
    created: 1741996800,
    owned_by: 'google',
    description: 'Gemma 3 27B — 14,400 req/day (30 RPM) | 128K ctx'
  },
  {
    id: 'gemma-3-12b-it',
    object: 'model',
    created: 1741996800,
    owned_by: 'google',
    description: 'Gemma 3 12B — 14,400 req/day (30 RPM) | 128K ctx'
  },
  {
    id: 'gemma-3-4b-it',
    object: 'model',
    created: 1741996800,
    owned_by: 'google',
    description: 'Gemma 3 4B — 14,400 req/day (30 RPM) | 128K ctx'
  },
  {
    id: 'gemma-3-2b-it',
    object: 'model',
    created: 1741996800,
    owned_by: 'google',
    description: 'Gemma 3 2B — 14,400 req/day (30 RPM) | 128K ctx'
  },
  {
    id: 'gemma-3-1b-it',
    object: 'model',
    created: 1741996800,
    owned_by: 'google',
    description: 'Gemma 3 1B — 14,400 req/day (30 RPM) | 128K ctx'
  },

  // ---------- Gemini 2.5 系列 ----------
  {
    id: 'gemini-2.5-flash-exp',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    description: 'Gemini 2.5 Flash Exp — 10,000 req/day (250 RPM) | 1M ctx 🚀'
  },
  {
    id: 'gemini-2.5-pro-1p-freebie',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    description: 'Gemini 2.5 Pro (Trial) — 500 req/day (75 RPM) | 免费试用'
  },
  {
    id: 'gemini-2.5-flash',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    description: 'Gemini 2.5 Flash — 20 req/day (5 RPM) | 1M ctx ⚠️ 今日已达上限'
  },
  {
    id: 'gemini-2.5-flash-lite',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    description: 'Gemini 2.5 Flash-Lite — 20 req/day (10 RPM) | 1M ctx ⚠️ 今日已达上限'
  },
  {
    id: 'gemini-2.5-flash-tts',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    description: 'Gemini 2.5 Flash TTS — 10 req/day (3 RPM) | TTS 专用'
  },

  // ---------- Gemini 3 系列 ----------
  {
    id: 'gemini-3-flash',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    description: 'Gemini 3 Flash — 20 req/day (5 RPM) | 1M ctx'
  },
  {
    id: 'gemini-3.1-flash-lite',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    description: 'Gemini 3.1 Flash-Lite — 500 req/day (15 RPM)'
  },
  {
    id: 'gemini-3.1-flash-tts',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    description: 'Gemini 3.1 Flash TTS — 10 req/day (3 RPM) | TTS 专用'
  },

  // ---------- 其他免费模型 ----------
  {
    id: 'med-gemini',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    description: 'Med-Gemini — 50,000 req/day (60 RPM) | 医学专用'
  },
  {
    id: 'learnlm-2.0-flash-experimental',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    description: 'LearnLM 2.0 Flash — 1,500 req/day (15 RPM) | 学习专用'
  },
  {
    id: 'gemini-robotics-er-1.6-preview',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    description: 'Robotics ER 1.6 Preview — 20 req/day (5 RPM)'
  },
  {
    id: 'gemini-robotics-er-1.5-preview',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    description: 'Robotics ER 1.5 Preview — 20 req/day (10 RPM)'
  }
];

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

    // 直接转发请求，不使用任何 TransformStream
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: body,
      cache: 'no-store',
    });

    console.log(`[Proxy] Response status: ${response.status}`);

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
