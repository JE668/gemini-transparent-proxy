// app/api/recent/route.js
import { getQuotaDate } from '../../../lib/utils';
import getRedis from '../../../lib/redis';

export async function GET() {
  try {
    const redis = getRedis();
    const date = getQuotaDate();
    
    const [recentRaw, retryCount, slowRequestsRaw] = await Promise.all([
      redis?.lrange(`recent:${date}`, 0, 29),
      redis?.get(`retries:${date}`),
      redis?.zrange(`slow:${date}`, 0, 9, { rev: true, withScores: true }),
    ]);

    const recent = (recentRaw || [])
      .map(entry => (typeof entry === 'string' ? JSON.parse(entry) : entry))
      .filter(Boolean);

    // 解析慢请求（sorted set 返回 [member, score, member, score, ...]）
    const slowRequests = [];
    if (slowRequestsRaw && slowRequestsRaw.length > 0) {
      for (let i = 0; i < slowRequestsRaw.length; i += 2) {
        try {
          const req = JSON.parse(slowRequestsRaw[i]);
          slowRequests.push({
            ...req,
            latency: parseInt(slowRequestsRaw[i + 1]),
          });
        } catch (e) {
          console.error('解析慢请求失败:', e);
        }
      }
    }

    return Response.json({
      date,
      retries: retryCount || 0,
      recent,
      slowRequests,
    });
  } catch (err) {
    console.error('Recent API Error:', err);
    return Response.json({ error: '获取最近请求失败' }, { status: 500 });
  }
}
