// app/api/[[...path]]/route.js
// Gemini 透明代理 - Next.js App Router Edge Function (优化版)
// 将 OpenAI 兼容格式的请求转发到 Google Gemini API
// 支持流式输出 (SSE) 和非流式输出

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';
const DEFAULT_TIMEOUT_MS = 30000; // 30秒默认超时
const REQUEST_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
const LOG_REDACT_KEYS = process.env.LOG_REDACT_KEYS !== 'false'; // 默认脱敏

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

// 需要在转发前删除的请求头（Hop-by-hop）
const HOP_BY_HOP_HEADERS = new Set([
    'host', 'connection', 'keep-alive', 'proxy-authorization',
    'proxy-authenticate', 'te', 'trailers', 'transfer-encoding',
    'upgrade', 'content-length'
]);

// 需要在响应中删除的头部（只删除真正连接相关的）
const BLOCKED_RESPONSE_HEADERS = new Set([
    'connection', 'keep-alive', 'strict-transport-security'
]);

// 基础 CORS 头（可用于所有响应）
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
};

// 辅助函数：为响应添加 CORS 头
function addCorsHeaders(responseInit = {}) {
    return {
        ...responseInit,
        headers: {
            ...CORS_HEADERS,
            ...(responseInit.headers || {})
        }
    };
}

// 辅助函数：脱敏日志中的 URL（隐藏 key 参数）
function redactUrl(urlString) {
    if (!LOG_REDACT_KEYS) return urlString;
    try {
        const url = new URL(urlString);
        if (url.searchParams.has('key')) {
            url.searchParams.set('key', 'REDACTED');
        }
        return url.toString();
    } catch {
        return urlString;
    }
}

// 清理请求头
function cleanRequestHeaders(headers) {
    const clean = new Headers();
    for (const [key, value] of headers.entries()) {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
            // 如果开启脱敏且是 authorization 头，替换值
            if (LOG_REDACT_KEYS && key.toLowerCase() === 'authorization') {
                clean.set(key, 'Bearer REDACTED');
            } else {
                clean.set(key, value);
            }
        }
    }
    return clean;
}

// 构建目标 URL（带路径映射和查询参数白名单）
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

// 构建响应头（过滤 + CORS）
function buildResponseHeaders(response) {
    const headers = new Headers();
    for (const [key, value] of response.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (!BLOCKED_RESPONSE_HEADERS.has(lowerKey)) {
            headers.set(key, value);
        }
    }
    // 添加 CORS 头
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
        headers.set(key, value);
    }
    return headers;
}

// 处理 /v1/models 请求的响应
function handleModelsRequest() {
    return new Response(JSON.stringify({ object: 'list', data: HIGH_QUOTA_MODELS }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
        }
    });
}

// 主请求处理器
async function handleRequest(req) {
    const url = new URL(req.url);
    const { pathname, search } = url;

    console.log(`[Proxy] ${req.method} ${pathname}`);

    // 处理模型列表请求（兼容多种路径）
    if (pathname.endsWith('/models') || pathname.includes('/v1/models') || pathname.includes('/v1beta/openai/models')) {
        return handleModelsRequest();
    }

    let targetUrl = buildTargetUrl(pathname, search);
    
    // 准备要转发的请求头（已清理并可能脱敏）
    const headers = cleanRequestHeaders(req.headers);
    
    // === 认证桥接：从 Authorization: Bearer 提取 API Key 添加到 URL 参数 ===
    const authHeader = req.headers.get('authorization') || '';
    if (authHeader.startsWith('Bearer ')) {
        const apiKey = authHeader.slice(7).trim();
        const urlWithKey = new URL(targetUrl);
        urlWithKey.searchParams.set('key', apiKey);
        targetUrl = urlWithKey.toString();
        // 关键修复：删除 Authorization 头，避免双重认证冲突
        headers.delete('authorization');
    }

    // 日志打印（脱敏后的 URL）
    console.log(`[Proxy] Forwarding to: ${redactUrl(targetUrl)}`);

    // 请求体：直接使用 ReadableStream，避免内存加载
    const body = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : req.body;

    // 超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: headers,
            body: body,
            signal: controller.signal,
            cache: 'no-store',
            // 对于流式响应，保持连接打开
            duplex: 'half', // 在 Edge Runtime 中，使用 ReadableStream body 需要明确 duplex
        });

        clearTimeout(timeoutId);
        console.log(`[Proxy] Response status: ${response.status}`);

        // 流式转发响应体
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: buildResponseHeaders(response),
        });
    } catch (fetchError) {
        clearTimeout(timeoutId);
        console.error('[Proxy] Fetch error:', fetchError);
        
        let status = 502;
        let message = `Proxy Error: ${fetchError.message}`;
        if (fetchError.name === 'AbortError') {
            message = `Request timed out after ${REQUEST_TIMEOUT_MS}ms`;
            status = 504; // Gateway Timeout
        }
        
        return new Response(JSON.stringify({
            error: {
                message: message,
                type: 'proxy_error',
                code: status
            }
        }), {
            status: status,
            headers: {
                'Content-Type': 'application/json',
                ...CORS_HEADERS,
            }
        });
    }
}

// Edge Runtime 声明
export const runtime = 'edge';

// 导出 HTTP 方法处理器
export async function GET(req) { return handleRequest(req); }
export async function POST(req) { return handleRequest(req); }
export async function PUT(req) { return handleRequest(req); }
export async function DELETE(req) { return handleRequest(req); }
export async function OPTIONS(req) {
    // 预检请求直接返回 CORS 头
    return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
    });
}
