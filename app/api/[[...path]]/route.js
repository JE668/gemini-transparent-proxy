// app/api/[[...path]]/route.js
import { NextResponse } from 'next/server';

export const runtime = 'edge';

/**
 * 统一的请求处理器
 */
async function handleRequest(req) {
  try {
    const url = new URL(req.url);
    let pathname = url.pathname;

    // ---------- 路径重写 ----------
    if (pathname.startsWith('/api/v1/')) {
      // OpenAI 格式 -> Gemini OpenAI 兼容端点
      pathname = pathname.replace('/api/v1/', '/v1beta/openai/');
    } else if (pathname.startsWith('/api/')) {
      // 原生 Gemini 格式
      pathname = pathname.replace('/api/', '/');
    }
    // -----------------------------

    const targetUrl = `https://generativelanguage.googleapis.com${pathname}${url.search}`;

    // 克隆请求头，移除原始 host 避免被 Google 拒绝
    const headers = new Headers(req.headers);
    headers.delete('host');

    // 转发到 Google API
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
    });

    // 构造返回给客户端的响应
    const responseHeaders = new Headers();
    
    // 透传 Google 返回的 Content-Type
    const contentType = response.headers.get('content-type');
    responseHeaders.set('Content-Type', contentType || 'application/json');

    // 设置 CORS 头
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    responseHeaders.set('Access-Control-Expose-Headers', '*');

    return new NextResponse(response.body, {
      status: response.status,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error('Proxy error:', error);
    return NextResponse.json(
      { error: 'Proxy Error', details: error.message },
      { 
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': '*',
        }
      }
    );
  }
}

// 导出 HTTP 方法
export async function GET(request) {
  return handleRequest(request);
}

export async function POST(request) {
  return handleRequest(request);
}

export async function PUT(request) {
  return handleRequest(request);
}

export async function DELETE(request) {
  return handleRequest(request);
}

// 处理预检请求（OPTIONS），浏览器跨域必须
export async function OPTIONS(request) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  });
}
