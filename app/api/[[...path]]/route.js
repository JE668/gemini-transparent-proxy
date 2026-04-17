// app/api/[[...path]]/route.js
import { NextResponse } from 'next/server';

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
    // 如果客户端通过 x-goog-api-key 头传递密钥，确保它被转发
    // （Google 支持 x-goog-api-key 或 Authorization: Bearer <key>）

    // 获取请求体（非 GET/HEAD 时）
    const body = req.method !== 'GET' && req.method !== 'HEAD' ? await req.text() : undefined;

    // 转发到 Google API
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });

    // 构造返回给客户端的响应，保留原始状态和内容类型，同时添加 CORS 头
    const responseData = await response.text();
    const responseHeaders = new Headers();
    
    // 透传 Google 返回的 Content-Type（通常是 application/json）
    const contentType = response.headers.get('content-type');
    if (contentType) {
      responseHeaders.set('Content-Type', contentType);
    } else {
      responseHeaders.set('Content-Type', 'application/json');
    }

    // 设置 CORS 头，允许任意来源访问（生产环境可根据需要收紧）
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    // 允许浏览器读取自定义响应头（如流式响应的 text/event-stream）
    responseHeaders.set('Access-Control-Expose-Headers', '*');

    return new NextResponse(responseData, {
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
