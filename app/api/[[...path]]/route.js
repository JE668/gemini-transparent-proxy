// Gemini 透明代理 - 绝对稳定版
import { Redis } from '@upstash/redis';

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';

// Redis 客户端初始化
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// 高配额模型列表
const HIGH_QUOTA_MODELS = [
 // ========== Gemma 4 系列 (高配额，开源) ==========
 {
 id: 'gemma-4-31b-it',
 object: 'model',
 created: 1743561600,
 owned_by: 'google',
 description: 'Gemma 4 31B (Dense) — 1,500 req/day (15 RPM, TPM unlimited) | 256K ctx ⭐ 主力'
 },
 {
 id: 'gemma-4-26b-a4b-it',
 object: 'model',
 created: 1743561600,
 owned_by: 'google',
 description: 'Gemma 4 26B A4B (MoE) — 1,500 req/day (15 RPM, TPM unlimited) | 256K ctx'
 },

 // ========== Gemma 3 系列 (14,400 req/day) ==========
 {
 id: 'gemma-3-27b-it',
 object: 'model',
 created: 1741996800,
 owned_by: 'google',
 description: 'Gemma 3 27B — 14,400 req/day (30 RPM, 15K TPM) | 128K ctx'
 },
 {
 id: 'gemma-3-12b-it',
 object: 'model',
 created: 1741996800,
 owned_by: 'google',
 description: 'Gemma 3 12B — 14,400 req/day (30 RPM, 15K TPM) | 128K ctx'
 },
 {
 id: 'gemma-3-4b-it',
 object: 'model',
 created: 1741996800,
 owned_by: 'google',
 description: 'Gemma 3 4B — 14,400 req/day (30 RPM, 15K TPM) | 128K ctx'
 },
 {
 id: 'gemma-3-2b-it',
 object: 'model',
 created: 1741996800,
 owned_by: 'google',
 description: 'Gemma 3 2B — 14,400 req/day (30 RPM, 15K TPM) | 128K ctx'
 },
 {
 id: 'gemma-3-1b-it',
 object: 'model',
 created: 1741996800,
 owned_by: 'google',
 description: 'Gemma 3 1B — 14,400 req/day (30 RPM, 15K TPM) | 128K ctx'
 },

 // ========== Gemini 2.5 系列 ==========
 {
 id: 'gemini-2.5-flash-exp',
 object: 'model',
 created: 1740960000,
 owned_by: 'google',
 description: 'Gemini 2.5 Flash Exp — 10,000 req/day (250 RPM, 1M TPM) | 1M ctx 🚀'
 },
 {
 id: 'gemini-2.5-pro-1p-freebie',
 object: 'model',
 created: 1740960000,
 owned_by: 'google',
 description: 'Gemini 2.5 Pro (Trial) — 500 req/day (75 RPM, 1M TPM)'
 },
 {
 id: 'gemini-2.5-flash',
 object: 'model',
 created: 1740960000,
 owned_by: 'google',
 description: 'Gemini 2.5 Flash — 20 req/day (5 RPM, 250K TPM) | 1M ctx'
 },
 {
 id: 'gemini-2.5-flash-lite',
 object: 'model',
 created: 1740960000,
 owned_by: 'google',
 description: 'Gemini 2.5 Flash-Lite — 20 req/day (10 RPM, 250K TPM) | 1M ctx'
 },
 {
 id: 'gemini-2.5-flash-tts',
 object: 'model',
 created: 1740960000,
 owned_by: 'google',
 description: 'Gemini 2.5 Flash TTS — 10 req/day (3 RPM, 10K TPM) | TTS 专用'
 },

 // ========== Gemini 3 系列 ==========
 {
 id: 'gemini-3-flash',
 object: 'model',
 created: 1740960000,
 owned_by: 'google',
 description: 'Gemini 3 Flash — 20 req/day (5 RPM, 250K TPM) | 1M ctx'
 },
 {
 id: 'gemini-3.1-flash-lite',
 object: 'model',
 created: 1740960000,
 owned_by: 'google',
 description: 'Gemini 3.1 Flash-Lite — 500 req/day (15 RPM, 250K TPM)'
 },
 {
 id: 'gemini-3.1-flash-tts',
 object: 'model',
 created: 1740960000,
 owned_by: 'google',
 description: 'Gemini 3.1 Flash TTS — 10 req/day (3 RPM, 10K TPM) | TTS 专用'
 }
];

const HOP_BY_HOP_HEADERS = ['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'content-length'];
const BLOCKED_RESPONSE_HEADERS = ['content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'strict-transport-security'];

/**
 * 记录统计数据到 Redis
 */
async function recordUsage(model, usage) {
    if (!model || !usage) return;
    
    const date = new Date().toISOString().split('T')[0];
    const key = `usage:${date}:${model}`;
    
    try {
        await redis.hIncrBy(key, 'calls', 1);
        if (usage.prompt_tokens) await redis.hIncrBy(key, 'prompt_tokens', usage.prompt_tokens);
        if (usage.completion_tokens) await redis.hIncrBy(key, 'completion_tokens', usage.completion_tokens);
        
        // 更新索引
        await redis.sAdd('all_models', model);
        await redis.sAdd('all_dates', date);
        console.log(`[Stats] Recorded usage for ${model} on ${date}`);
    } catch (e) {
        console.error('[Stats] Redis Error:', e);
    }
}

async function getRequestBody(req) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return undefined;
    return await req.text();
}

function cleanHeaders(headers) {
    const clean = new Headers(headers);
    HOP_BY_HOP_HEADERS.forEach(h => clean.delete(h));
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
        for (const [k, v] of params) { if (allowed.includes(k)) filtered.set(k, v); }
        const filteredStr = filtered.toString();
        return `${GOOGLE_API_BASE}${targetPath}${filteredStr ? '?' + filteredStr : ''}`;
    }
    return `${GOOGLE_API_BASE}${targetPath}`;
}

function buildResponseHeaders(response) {
    const headers = new Headers();
    for (const [key, value] of response.headers.entries()) {
        if (!BLOCKED_RESPONSE_HEADERS.includes(key.toLowerCase())) headers.set(key, value);
    }
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', '*');
    return headers;
}

async function handleRequest(req) {
    try {
        const url = new URL(req.url);
        const { pathname, search } = url;

        if (pathname.endsWith('/models') || pathname.includes('/v1/models') || pathname.includes('/v1beta/openai/models')) {
            return new Response(JSON.stringify({ object: 'list', data: HIGH_QUOTA_MODELS }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': '*' }
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
          if (!isOpenAICompat) headers.delete('authorization');
        }

        const bodyText = await getRequestBody(req);
        let model = 'unknown';
        let isStreaming = false;

        if (bodyText) {
            try {
                const bodyJson = JSON.parse(bodyText);
                model = bodyJson.model || 'unknown';
                isStreaming = bodyJson.stream === true;
            } catch (e) {}
        }

        const response = await fetch(targetUrl, {
            method: req.method,
            headers: headers,
            body: bodyText,
            cache: 'no-store',
        });

        if (response.status !== 200) {
            return new Response(response.body, { status: response.status, statusText: response.statusText, headers: buildResponseHeaders(response) });
        }

        // === 统计处理 ===
        if (isStreaming) {
            // 流式处理：拦截最后一个 chunk 中的 usage
            const { readable, writable } = new TransformStream({
                transform(chunk, controller) {
                    // 简单的 Buffer 累积，尝试查找 usage
                    const text = new TextDecoder().decode(chunk);
                    if (text.includes('"usage":')) {
                        try {
                            // 尝试提取最后一个 JSON chunk
                            const parts = text.split('data: ');
                            const lastPart = parts[parts.length - 1].trim();
                            if (lastPart && lastPart !== '[DONE]') {
                                const json = JSON.parse(lastPart);
                                if (json.usage) recordUsage(model, json.usage);
                            }
                        } catch (e) {
                            // 忽略解析错误，因为 usage 可能被切分
                        }
                    }
                    controller.enqueue(chunk);
                }
            });

            return new Response(response.body.pipeThrough(readable), {
                status: response.status,
                statusText: response.statusText,
                headers: buildResponseHeaders(response),
            });
        } else {
            // 非流式处理：克隆响应体
            const clonedRes = response.clone();
            const resText = await clonedRes.text();
            try {
                const resJson = JSON.parse(resText);
                if (resJson.usage) recordUsage(model, resJson.usage);
            } catch (e) {}

            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: buildResponseHeaders(response),
            });
        }

    } catch (error) {
        console.error('[Proxy] Error:', error);
        return new Response(JSON.stringify({ error: { message: `Proxy Error: ${error.message}`, type: 'proxy_error', code: 502 } }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': '*' }
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
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': '*' },
    });
}
