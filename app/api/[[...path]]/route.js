import { NextResponse } from 'next/server';

async function handleRequest(req) {
  // 1. 解析请求路径
  const url = new URL(req.url);
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
      },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
    });

    // 5. 将 Google 的响应原封不动返回
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

// 导出所有支持的 HTTP 方法
export { handleRequest as GET, handleRequest as POST, handleRequest as PUT, handleRequest as DELETE, handleRequest as OPTIONS };
