export const runtime = 'edge';

async function checkGeminiAPI(apiKey) {
  const start = Date.now();
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const latency = Date.now() - start;
    if (res.ok) {
      return { status: 'ok', latency, message: 'Gemini API 正常' };
    } else {
      return { status: 'error', latency, message: `HTTP ${res.status}` };
    }
  } catch (err) {
  return { status: 'error', latency: Date.now() - start, message: '连接失败' };
  }
}

export async function GET(req) {
  // 从环境变量读取你的 API Key
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return Response.json({ status: 'error', message: '未配置 API Key' }, { status: 500 });
  }
  const result = await checkGeminiAPI(apiKey);
  return Response.json(result);
}
