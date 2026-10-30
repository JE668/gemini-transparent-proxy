import { isDashboardAuthed, unauthorizedResponse } from '../../../lib/auth';
// app/api/recent/route.js
import { getQuotaDate } from '../../../lib/utils';
import getRedis from '../../../lib/redis';

export async function GET(req) {
  if (!isDashboardAuthed(req)) return unauthorizedResponse();
  try {
    // ⚠️ Redis 未配置时提前返回：旧实现 `redis?.lrange(...)` 得到 undefined，
    //    后续 `redis?.zrange(..., { withScores: true })` 同样为空 → 尚可，
    //    但 `redis` 为 null 时下游任何直接调用都会抛错，统一降级更安全。
    const redis = getRedis();
    if (!redis) {
      return Response.json({ date: getQuotaDate(), redisEnabled: false, retries: 0, recent: [], slowRequests: [] });
    }

    const date = getQuotaDate();

    const [recentRaw, retryCount, slowRequestsRaw] = await Promise.all([
      redis.lrange(`recent:${date}`, 0, 29),
      redis.get(`retries:${date}`),
      redis.zrange(`slow:${date}`, 0, 9, { rev: true, withScores: true }),
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
