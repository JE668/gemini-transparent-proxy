/**
 * Cloudflare Workers Gemini Proxy
 * 
 * 部署方式:
 * 1. npm install -g wrangler
 * 2. cd cloudflare-worker
 * 3. wrangler deploy
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      let pathname = url.pathname;

      // ---------- 路径重写 ----------
      if (pathname.startsWith('/api/v1/')) {
        pathname = pathname.replace('/api/v1/', '/v1beta/openai/');
      } else if (pathname.startsWith('/api/')) {
        pathname = pathname.replace('/api/', '/');
      }
      // -----------------------------

      const targetUrl = `https://generativelanguage.googleapis.com${pathname}${url.search}`;

      // 克隆请求头，移除原始 host
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.set('Content-Type', 'application/json');

      // 转发请求，直接使用原始请求体（流式）
      const response = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: request.body,
      });

      // 构造响应
      const responseHeaders = new Headers();
      const contentType = response.headers.get('content-type');
      responseHeaders.set('Content-Type', contentType || 'application/json');
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', '*');
      responseHeaders.set('Access-Control-Expose-Headers', '*');

      // 直接返回流式响应
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