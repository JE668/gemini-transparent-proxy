/**
 * Cloudflare Workers Gemini Proxy
 * 
 * 部署方式:
 * 1. 安装 Wrangler: npm install -g wrangler
 * 2. wrangler init (创建一个新 worker)
 * 3. 把本文件内容替换到 src/index.js
 * 4. wrangler deploy
 * 
 * 使用方式:
 * 将原本发往 https://generativelanguage.googleapis.com 的请求
 * 改为发往 https://your-worker.workers.dev
 * 
 * 例如:
 * 原本: https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=YOUR_KEY
 * 改为: https://your-worker.workers.dev/v1beta/models/gemini-2.0-flash:generateContent?key=YOUR_KEY
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
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

      // 克隆请求头，移除原始 host
      const headers = new Headers(request.headers);
      headers.delete('host');
      // 确保 Content-Type 正确
      headers.set('Content-Type', 'application/json');

      // 转发请求，直接使用原始请求体
      const response = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: request.body,
      });

      // 构造响应
      const responseHeaders = new Headers();
      
      // 透传 Google 返回的 Content-Type
      const contentType = response.headers.get('content-type');
      responseHeaders.set('Content-Type', contentType || 'application/json');

      // 设置 CORS 头
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', '*');
      responseHeaders.set('Access-Control-Expose-Headers', '*');

      // 直接返回流式响应（不缓冲）
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });

    } catch (error) {
      console.error('Proxy error:', error);
      return new Response(
        JSON.stringify({ error: 'Proxy Error', details: error.message }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          }
        }
      );
    }
  }
};