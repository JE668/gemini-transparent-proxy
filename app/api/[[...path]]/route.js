// app/api/[[...path]]/route.js
import { NextResponse } from 'next/server';

/**
 * 统一的流式代理请求处理器
 */
async function handleStreamRequest(req) {
    try {
        const url = new URL(req.url);
        let pathname = url.pathname;

        // ---------- 路径重写 ----------
        if (pathname.startsWith('/api/v1/')) {
            pathname = pathname.replace('/api/v1/', '/v1beta/openai/');
        } else if (pathname.startsWith('/api/')) {
            pathname = pathname.replace('/api/', '/');
        }
        // -----------------------------

        const targetUrl = `https://generativelanguage.googleapis.com${pathname}${url.search}`;

        // 克隆请求头，并清理会导致问题的 Hop-by-hop headers
        const headers = new Headers(req.headers);
        headers.delete('host');
        // 清理更多可能干扰代理的头部
        ['connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailers', 'transfer-encoding', 'upgrade'].forEach(h => headers.delete(h));

        // 读取请求体（仅对非 GET/HEAD 请求）
        const body = req.method !== 'GET' && req.method !== 'HEAD' ? await req.text() : undefined;

        // 转发到 Google API，注意此处不等待完整响应，而是获取可读流
        const response = await fetch(targetUrl, {
            method: req.method,
            headers,
            body,
        });

        // 构造响应头，过滤掉不应直接转发的头部
        const responseHeaders = new Headers();
        for (const [key, value] of response.headers.entries()) {
            const lowerKey = key.toLowerCase();
            if (['content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'strict-transport-security'].includes(lowerKey)) {
                continue;
            }
            responseHeaders.set(key, value);
        }
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        responseHeaders.set('Access-Control-Allow-Headers', '*');

        // 关键步骤：返回流式响应，而非缓冲后的一次性响应
        return new NextResponse(response.body, {
            status: response.status,
            headers: responseHeaders,
        });

    } catch (error) {
        console.error('Proxy error:', error);
        return NextResponse.json(
            { error: 'Proxy Error', details: error.message },
            { status: 502 }
        );
    }
}

export async function GET(req) {
    return handleStreamRequest(req);
}

export async function POST(req) {
    return handleStreamRequest(req);
}

export async function PUT(req) {
    return handleStreamRequest(req);
}

export async function DELETE(req) {
    return handleStreamRequest(req);
}

export async function OPTIONS(req) {
    return new NextResponse(null, {
        status: 200,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*',
        },
    });
}
