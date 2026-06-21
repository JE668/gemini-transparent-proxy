// 调试端点：显示最后一次请求和响应的信息
export const runtime = 'nodejs';

export async function GET() {
  return new Response(JSON.stringify({
    lastRequest: globalThis.__LAST_REQUEST || null,
    lastResponse: globalThis.__LAST_RESPONSE || null,
    timestamp: new Date().toISOString()
  }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
