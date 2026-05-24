// app/api/errors/route.js
import { Redis } from '@upstash/redis';
import { getQuotaDate } from '../../../lib/utils';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function GET() {
  try {
    const date = getQuotaDate();
    const rawEntries = await redis.lrange(`errors:${date}`, 0, 19);

    const errors = rawEntries.map(entry => {
      try {
        return typeof entry === 'string' ? JSON.parse(entry) : entry;
      } catch {
        return { ts: entry, model: 'unknown', status: 0, latency: 0 };
      }
    });

    return Response.json({
      date,
      count: errors.length,
      errors,
    });
  } catch (err) {
    console.error('Errors API Error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
