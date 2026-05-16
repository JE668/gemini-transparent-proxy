// app/api/[[...path]]/route.js
// Gemini 透明代理 - 稳定优化版
const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';
const DEFAULT_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);

// 高配额模型列表（保持不变）
const HIGH_QUOTA_MODELS = [ /* 你的模型列表，省略重复内容 */ ];

// Hop-by-hop 请求头（需要删除的）
const HOP_BY_HOP_HEADERS = new Set([
    'host', 'connection', 'keep-alive', 'proxy-authorization',
    'proxy-authenticate', 'te', 'trailers', 'transfer-encoding',
    'upgrade', 'content-length'
]);

// 需要过滤的响应头（仅连接相关）
const BLOCKED_RESPONSE_HEADERS = new Set([
    'connection', 'keep-alive', 'strict-transport-security'
]);

// CORS 头
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
};

// ---------- 辅助函数 ----------
function cleanHeaders(headers) {
    const clean = new Headers();
    for (const [key, value] of headers.entries()) {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
            // 注意：不要修改 value 内容！保持原样
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
        if (!BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase())) {
            headers.set(key, value);
        }
    }
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
        headers.set(k, v);
    }
    return headers;
}

function handleModelsRequest() {
    return new Response(JSON.stringify({ object: 'list', data: HIGH_QUOTA_MODELS }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
}

// ---------- 主处理器 ----------
async function handleRequest(req) {
    const url = new URL(req.url);
    const { pathname, search } = url;
    console.log(`[Proxy] ${req.method} ${pathname}`);

    // 模型列表请求
    if (pathname.endsWith('/models') || pathname.includes('/v1/models') || pathname.includes('/v1beta/openai/models')) {
        return handleModelsRequest();
    }

    let targetUrl = buildTargetUrl(pathname, search);
    const headers = cleanHeaders(req.headers);
    
    // 认证桥接：从 Authorization: Bearer 提取 API Key，添加到 URL 的 key 参数，并删除 Authorization 头
    const authHeader = req.headers.get('authorization') || '';
    if (authHeader.startsWith('Bearer ')) {
        const apiKey = authHeader.slice(7).trim();
        if (apiKey) { // 确保 key 非空
            const urlWithKey = new URL(targetUrl);
            urlWithKey.searchParams.set('key', apiKey);
            targetUrl = urlWithKey.toString();
        }
        // 无论何种情况，都删除 Authorization 头，避免双重认证
        headers.delete('authorization');
    }

    // 日志（手动脱敏，不修改实际 header）
    const logUrl = new URL(targetUrl);
    if (logUrl.searchParams.has('key')) logUrl.searchParams.set('key', 'REDACTED');
    console.log(`[Proxy] Forwarding to: ${logUrl.toString()}`);

    // 请求体：直接使用流（避免内存占用）
    const body = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : req.body;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: headers,
            body: body,
            signal: controller.signal,
            cache: 'no-store',
            // 在 Edge Runtime 中使用 ReadableStream body 需要 duplex 选项
            duplex: 'half',
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
        console.error('[Proxy] Fetch error:', fetchError);
        let status = 502;
        let message = `Proxy Error: ${fetchError.message}`;
        if (fetchError.name === 'AbortError') {
            message = `Request timed out after ${REQUEST_TIMEOUT_MS}ms`;
            status = 504;
        }
        return new Response(JSON.stringify({
            error: { message, type: 'proxy_error', code: status }
        }), {
            status: status,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
    }
}

export const runtime = 'edge';
export async function GET(req) { return handleRequest(req); }
export async function POST(req) { return handleRequest(req); }
export async function PUT(req) { return handleRequest(req); }
export async function DELETE(req) { return handleRequest(req); }
export async function OPTIONS(req) {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}
