// app/api/recent/route.js
import { getQuotaDate } from '../../../lib/utils';
import getRedis from '../../../lib/redis';

export async function GET() {
  try {
    const date = getQuotaDate();
    const [recentRaw, retryCount] = await Promise.all([
      getRedis().lrange(`recent:${date}`, 0, 29),
      getRedis().get(`retries:${date}`),
    ]);

    const recent = (recentRaw || [])
      .map(entry => (typeof entry === 'string' ? JSON.parse(entry) : entry))
      .filter(Boolean);

    return Response.json({
      date,
      retries: retryCount || 0,
      recent,
    });
  } catch (err) {
    console.error('Recent API Error:', err);
    return Response.json({ error: '获取最近请求失败' }, { status: 500 });
  }
}
