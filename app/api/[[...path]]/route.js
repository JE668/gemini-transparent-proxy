export async function GET(request) {
    return handleRequest(request);
}

export async function POST(request) {
    return handleRequest(request);
}

async function handleRequest(request) {
    const url = new URL(request.url);
    
    // --- 核心修改：路径重写逻辑 ---
    let pathname = url.pathname;

    if (pathname.startsWith('/api/v1/')) {
        // 如果是 OpenAI 格式请求 (/api/v1/...) -> 转换为 Gemini 的 OpenAI 兼容路径 (/v1beta/openai/...)
        pathname = pathname.replace('/api/v1/', '/v1beta/openai/');
    } else if (pathname.startsWith('/api/')) {
        // 如果是普通 Gemini 请求 (/api/v1beta/...) -> 转换为 (/v1beta/...)
        pathname = pathname.replace('/api/', '/');
    }
    // ----------------------------

    const targetUrl = `https://generativelanguage.googleapis.com${pathname}${url.search}`;

    const headers = new Headers(request.headers);
    headers.set('host', 'generativelanguage.googleapis.com');

    try {
        const response = await fetch(targetUrl, {
            method: request.method,
            headers: headers,
            body: request.method !== 'GET' ? await request.text() : undefined,
        });

        return response;
    } catch (error) {
        return new Response(JSON.stringify({ error: 'Proxy error: '
