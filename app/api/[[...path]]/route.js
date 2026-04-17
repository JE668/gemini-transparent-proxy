import { NextResponse } from 'next/server';

async function handleRequest(req) {
  try {
    const url = new URL(req.url);
    
    // 1. 提取路径：去掉 /api 前缀
    // 例如: /api/v1beta/models... -> /v1beta/models...
    const path = url.pathname.replace(/^\/api/, ''); 
    const searchParams = url.search;

    // 2. 构造目标 Google API 地址
    const targetUrl = `https://generativelanguage.googleapis.com${path}${searchParams}`;

    // 3. 关键修复：克隆所有请求头
    // 我们需要把客户端传来的 API Key (无论是在 Header 还是 URL 中) 全部转发给 Google
    const requestHeaders = new Headers(req.headers);
    requestHeaders.delete('host'); // 必须删除 host 头，否则 Google 会拒绝请求

    // 4. 获取请求体
    const body = await req.text();

    // 5. 转发请求
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: requestHeaders, 
      body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
    });

    // 6. 将 Google 的响应原封不动返回给客户端
    const responseData = await response.text();
    
    return new NextResponse(responseData, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', 
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    });
  } catch (error) {
    return NextResponse.json({ error: 'Proxy Error', details: error.message }, { status: 500 });
  }
}

export { handleRequest as GET, handleRequest as POST, handleRequest as PUT, handleRequest as DELETE, handleRequest as OPTIONS };
