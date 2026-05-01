// app/api/[[...path]]/route.js
// Gemini 透明代理 - Next.js App Router Edge Function
// 将 OpenAI 兼容格式的请求转发到 Google Gemini API
// 支持流式输出 (SSE) 和非流式输出

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';

/**
 * 获取客户端请求的真实路径
 * Next.js App Router 的 [[...path]] catch-all 路由中，
 * 路径参数可以从 `req.nextUrl.pathname` 或 `req.url` 中获取
 */
function getRequestPath(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;

    // Vercel 部署时，如果路径包含 /api/v1/，保留它
    // 如果 pathname 已经被 Vercel 裁剪过（比如只有 /chat/completions），
    // 我们需要从完整的 req.url 中提取
    // 但更可靠的方式是使用 req.nextUrl.pathname

    return pathname;
}

/**
 * 获取请求体内容（支持文本和二进制）
 */
async function getRequestBody(req) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
        return undefined;
    }
    return await req.text();
}

/**
 * 清理请求头中的 Hop-by-hop headers
 */
function cleanHeaders(headers) {
    const clean = new Headers(headers);
    const hopByHop = [
        'host', 'connection', 'keep-alive', 'proxy-authorization',
        'proxy-authenticate', 'te', 'trailers', 'transfer-encoding',
        'upgrade', 'content-length'
    ];
    hopByHop.forEach(h => clean.delete(h));
    return clean;
}

/**
 * 构建目标 URL
 * 将 OpenAI 兼容路径映射到 Google Gemini v1beta/openai 路径
 * 保留所有查询参数
 *
 * 路径映射规则（按优先级）：
 *   /api/v1/* -> /v1beta/openai/*
 *   /v1/*      -> /v1beta/openai/*
 *   /api/*     -> /* （其他 API 路径，保持兼容）
 *
 * 注意：Vercel [[...path]] 路由的 pathname 是完整的 URL 路径
 * 例如请求 https://xxx.vercel.app/api/v1/chat/completions
 * pathname = /api/v1/chat/completions
 */
function buildTargetUrl(pathname, search) {
    let targetPath = pathname;

    // 优先匹配长前缀，避免误替换
    if (targetPath.startsWith('/api/v1/')) {
        targetPath = '/v1beta/openai/' + targetPath.slice(8);
    } else if (targetPath.startsWith('/v1/')) {
        targetPath = '/v1beta/openai/' + targetPath.slice(3);
    } else if (targetPath.startsWith('/api/')) {
        targetPath = '/' + targetPath.slice(5);
    }

    return `${GOOGLE_API_BASE}${targetPath}${search}`;
}

/**
 * 构建响应头，过滤掉不应转发的头部
 */
function buildResponseHeaders(response) {
    const headers = new Headers();
    const blocked = [
        'content-encoding', 'transfer-encoding', 'connection',
        'keep-alive', 'strict-transport-security'
    ];

    for (const [key, value] of response.headers.entries()) {
        if (!blocked.includes(key.toLowerCase())) {
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
 * 处理所有请求（GET, POST, PUT, DELETE）
 */
async function handleRequest(req) {
    try {
        const url = new URL(req.url);
        const pathname = url.pathname;
        const search = url.search;

        console.log(`[Proxy] ${req.method} ${pathname}`);

        // === 处理 /v1/models 请求 ===
        // OpenAI 客户端在连接时会先请求 /v1/models
        // 我们需要返回一个可用的模型列表
        // 匹配各种可能的路径：/v1/models, /api/v1/models, /api/v1beta/openai/models, /models
        if (pathname.endsWith('/models') || pathname.includes('/v1/models') || pathname.includes('/v1beta/openai/models')) {
            const models = [
                {
                    id: 'gemini-2.0-flash',
                    object: 'model',
                    created: 1700000000,
                    owned_by: 'google'
                },
                {
                    id: 'gemini-2.0-flash-lite',
                    object: 'model',
                    created: 1700000000,
                    owned_by: 'google'
                },
                {
                    id: 'gemini-2.5-pro',
                    object: 'model',
                    created: 1700000000,
                    owned_by: 'google'
                },
                {
                    id: 'gemini-2.5-flash',
                    object: 'model',
                    created: 1700000000,
                    owned_by: 'google'
                },
                {
                    id: 'gemma-4-31b-it',
                    object: 'model',
                    created: 1700000000,
                    owned_by: 'google'
                }
            ];
            return new Response(JSON.stringify({
                object: 'list',
                data: models
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': '*',
                }
            });
        }

        // === 构建目标 URL ===
        const targetUrl = buildTargetUrl(pathname, search);

        console.log(`[Proxy] Forwarding to: ${targetUrl}`);

        // === 清理请求头 ===
        const headers = cleanHeaders(req.headers);

        // === 读取请求体 ===
        const body = await getRequestBody(req);

        // === 转发请求到 Google API ===
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: headers,
            body: body,
            // 不缓存，保持实时性
            cache: 'no-store',
        });

        console.log(`[Proxy] Response status: ${response.status}`);

        // === 构建响应头 ===
        const responseHeaders = buildResponseHeaders(response);

        // === 返回流式响应 ===
        // response.body 是 ReadableStream，Vercel Edge Runtime 原生支持
        // 这就是真正的流式传输 —— 不会等 Google 返回全部内容才开始发回客户端
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
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

// 导出的处理函数
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