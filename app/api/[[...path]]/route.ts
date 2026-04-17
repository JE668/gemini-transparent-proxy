import { NextRequest, NextResponse } from 'next/server';

async function handleRequest(req: NextRequest) {
  // 1. 解析请求路径
  const url = new URL(req.url);
  // 移除 /api 前缀，保留后面的所有路径 (例如 /v1beta/models/...)
  const path = url.pathname.replace(/^\/api/, ''); 
  const searchParams = url.search;

  // 2. 构造目标 Google API 地址
  const targetUrl = `https://generativelanguage.googleapis.com${path}${searchParams}`;

  try {
    // 3. 获取请求体
    const body = await req.text();

    // 4. 转发请求到 Google
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        // 这里不强制注入 Key，允许客户端在 URL 或 Header 中传递 Key
      },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
    });

    // 5. 将 Google 的响应原封不动返回
    const responseData = await response.text();
    
    return new NextResponse(responseData, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', // 允许所有客户端跨域调用
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: 'Proxy Error', details: error.message }, { status: 500 });
  }
}

// 导出所有支持的 HTTP 方法
export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const DELETE = handleRequest;
export const OPTIONS = handleRequest;
