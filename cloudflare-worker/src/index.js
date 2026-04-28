/**
 * Cloudflare Workers Gemini Proxy
 * 
 * 支持两种路径格式：
 * 1. OpenAI 格式: /v1/chat/completions -> 转发到 /v1beta/openai/chat/completions
 * 2. 原生 Gemini 格式: /v1/models/xxx:generateContent -> 直接转发
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let pathname = url.pathname;

    // ---------- /v1/models 端点（用于Hermes验证） ----------
    if (pathname === '/v1/models') {
      const models = {
        object: "list",
        data: [
          {
            id: "gemini-2.0-flash",
            object: "model",
            created: 1700000000,
            owned_by: "google",
          },
          {
            id: "gemini-2.0-flash-exp",
            object: "model",
            created: 1700000000,
            owned_by: "google",
          },
          {
            id: "gemini-1.5-flash",
            object: "model",
            created: 1700000000,
            owned_by: "google",
          },
          {
            id: "gemini-1.5-pro",
            object: "model",
            created: 1700000000,
            owned_by: "google",
          },
          {
            id: "gemini-pro",
            object: "model",
            created: 1700000000,
            owned_by: "google",
          },
        ]
      };
      return new Response(JSON.stringify(models), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }
    // -----------------------------------------------------

    try {
      // ---------- 路径重写 ----------
      // OpenAI 兼容格式: /v1/chat/completions -> /v1beta/openai/chat/completions
      if (pathname.startsWith('/v1/')) {
        pathname = pathname.replace('/v1/', '/v1beta/openai/');
      }
      // 原生 Gemini 格式保持不变: /v1/models/xxx:generateContent
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