// app/api/[[...path]]/route.js
// Gemini 透明代理 - Next.js App Router Edge Function
// 将 OpenAI 兼容格式的请求转发到 Google Gemini API
// 支持流式输出 (SSE) 和非流式输出

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';
const REQUEST_TIMEOUT_MS = 15000; // 15秒超时保护

// 高配额模型列表
const HIGH_QUOTA_MODELS = [
    {
        id: 'gemma-4-31b-it',
        object: 'model',
        created: 1743561600,
        owned_by: 'google',
        description: 'Gemma 4 31B — High Limit ⭐ 主力'
    },
    {
        id: 'gemma-4-26b-it',
        object: 'model',
        created: 1743561600,
        owned_by: 'google',
        description: 'Gemma 4 26B — High Limit'
    },
    {
        id: 'gemini-2.5-flash-exp',
        object: 'model',
        created: 1740960000,
        owned_by: 'google',
        description: 'Gemini 2.5 Flash Exp — Extremely High Limit 🚀'
    },
    {
        id: 'gemma-3-27b-it',
        object: 'model',
        created: 1741996800,
        owned_by: 'google',
        description: 'Gemma 3 27B — Ultra High Limit'
    },
    {
        id: 'gemma-3-12b-it',
        object: 'model',
        created: 1741996800,
        owned_by: 'google',
        description: 'Gemma 3 12B — Ultra High Limit'
    },
    {
        id: 'gemma-3-4b-it',
        object: 'model',
        created: 1741996800,
        owned_by: 'google',
        description: 'Gemma 3 4B — Ultra High Limit'
    },
    {
        id: 'gemma-3-2b-it',
        object: 'model',
        created: 1741996800,
        owned_by: 'google',
        description: 'Gemma 3 2B — Ultra High Limit'
    },
    {
        id: 'gemma-3-1b-it',
        object: 'model',
        created: 1741996800,
        owned_by: 'google',
        description: 'Gemma 3 1B — Ultra High Limit'
    }
];

// 常量定义：清理请求头中的 Hop-by-hop headers
const HOP_BY_HOP_HEADERS = [
    'host', 'connection', 'keep-alive', 'proxy-authorization',
    'proxy-authenticate', 'te', 'trailers', 'transfer-encoding',
    'upgrade', 'content-length'
];

// 常量定义：过滤掉不应转发的响应头部
const BLOCKED_RESPONSE_HEADERS = [
    'content-encoding', 'transfer-encoding', 'connection',
    'keep-alive', 'strict-transport-security'
];

/**
 * 获取请求体内容
 */
async function getRequestBody(req) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return undefined;
    }
    return await req.text();
}

/**
 * 清理请求头
 */
function cleanHeaders(headers) {
    const clean = new Headers(headers);
    HOP_BY_HOP_HEADERS.forEach(h => clean.delete(h));
    return clean;
}

/**
 * 构建目标 URL
 */
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
            if (allowed.includes(k)) {
                filtered.set(k, v);
            }
        }
        const filteredStr = filtered.toString();
        return `${GOOGLE_API_BASE}${targetPath}${filteredStr ? '?' + filteredStr : ''}`;
    }

    return `${GOOGLE_API_BASE}${targetPath}`;
}

/**
 * 构建响应头
 */
function buildResponseHeaders(response) {
    const headers = new Headers();
    for (const [key, value] of response.headers.entries()) {
        if (!BLOCKED_RESPONSE_HEADERS.includes(key.toLowerCase())) {
            headers.set(key, value);
        }
    }

    // CORS 头
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', '*');

    return headers;
}

/**
 * 处理所有请求
 */
async function handleRequest(req) {
    try {
        const url = new URL(req.url);
        const { pathname, search } = url;

        console.log(`[Proxy] ${req.method} ${pathname}`);

        // === 处理 /v1/models 请求 ===
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
        console.log(`[Proxy] Forwarding to: ${targetUrl}`);

        const headers = cleanHeaders(req.headers);
        
        // === 认证桥接：使用安全头 x-goog-api-key ===
        const authHeader = req.headers.get('authorization') || '';
        if (authHeader.startsWith('Bearer ')) {
            const apiKey = authHeader.slice(7).trim();
            headers.set('x-goog-api-key', apiKey);
            headers.delete('authorization');
        }

        const body = await getRequestBody(req);

        // === 增加请求超时控制 ===
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(targetUrl, {
                method: req.method,
                headers: headers,
                body: body,
                signal: controller.signal,
                cache: 'no-store',
            });

            clearTimeout(timeoutId);
            console.log(`[Proxy] Response status: ${response.status}`);

            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: buildResponseHeaders(response),
            });
        } catch (fetchError) {
            clearTimeout(timeoutId);
            if (fetchError.name === 'AbortError') {
                throw new Error('Request timed out after 15 seconds');
            }
            throw fetchError;
        }

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
