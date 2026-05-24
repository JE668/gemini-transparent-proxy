// app/api/recent/route.js
import { Redis } from '@upstash/redis';
import { getQuotaDate } from '../../../lib/utils';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function GET() {
  try {
    const date = getQuotaDate();
    const [recentRaw, retryCount] = await Promise.all([
      redis.lrange(`recent:${date}`, 0, 29),
      redis.get(`retries:${date}`),
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
    return Response.json({ error: err.message }, { status: 500 });
  }
}
