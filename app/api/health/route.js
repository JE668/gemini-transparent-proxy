export const runtime = 'edge';

import getRedis from '../../../lib/redis';

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

async function checkRedis() {
  const start = Date.now();
  try {
    const result = await getRedis()?.ping();
    const latency = Date.now() - start;
    if (result === 'PONG') {
      return { status: 'ok', latency, message: 'Redis 连接正常' };
    }
    return { status: 'warn', latency, message: `Redis 返回: ${result}` };
  } catch (err) {
    return { status: 'error', latency: Date.now() - start, message: '连接失败' };
  }
}

export async function GET(req) {
  // Bearer Token 认证：复用 DASHBOARD_PASSWORD
  const dashboardPassword = process.env.DASHBOARD_PASSWORD;
  if (dashboardPassword) {
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (token !== dashboardPassword) {
      return Response.json({ status: 'error', message: '未授权访问，请提供正确的 Bearer Token' }, { status: 401 });
    }
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return Response.json({ status: 'error', message: '未配置 API Key' }, { status: 500 });
  }

  // 并行检查 Gemini API 和 Redis
  const [geminiResult, redisResult] = await Promise.all([
    checkGeminiAPI(apiKey),
    checkRedis(),
  ]);

  const allOk = geminiResult.status === 'ok' && (redisResult.status === 'ok' || redisResult.status === 'warn');
  return Response.json({
    status: allOk ? 'ok' : 'degraded',
    gemini: geminiResult,
    redis: redisResult,
  });
}
