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
      pathname = pathname.replace('/api/v1/', '/v1beta/openai/');
    } else if (pathname.startsWith('/api/')) {
      pathname = pathname.replace('/api/', '/');
    }
    // -----------------------------

    const targetUrl = `https://generativelanguage.googleapis.com${pathname}${url.search}`;

    // 克隆请求头
    const headers = new Headers(req.headers);
    headers.delete('host');

    // 读取请求体
    const body = req.method !== 'GET' && req.method !== 'HEAD' ? await req.text() : undefined;

    // 转发到 Google API
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });

    // 读取响应文本（会缓冲）
    const responseData = await response.text();

    // 构造响应头
    const responseHeaders = new Headers();
    const contentType = response.headers.get('content-type');
    if (contentType) {
      responseHeaders.set('Content-Type', contentType);
    } else {
      responseHeaders.set('Content-Type', 'application/json');
    }
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
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