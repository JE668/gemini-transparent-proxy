// app/api/clients/route.js
import { Redis } from '@upstash/redis';
import { getQuotaDate } from '../../../lib/utils';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function GET() {
  try {
    const date = getQuotaDate();
    const keys = await redis.smembers(`clients:${date}:keys`);

    if (!keys || keys.length === 0) {
      return Response.json({ date, clients: [] });
    }

    // Pipeline 批量获取每个 key 的计数
    const pipeline = redis.pipeline();
    keys.forEach(k => pipeline.get(`clients:${date}:${k}`));
    const counts = await pipeline.exec();

    const clients = keys.map((k, i) => ({
      fingerprint: k,
      requests: counts[i] || 0,
    }));

    // 按请求数降序，取 Top 10
    clients.sort((a, b) => b.requests - a.requests);
    const top = clients.slice(0, 10);

    const total = clients.reduce((s, c) => s + c.requests, 0);

    return Response.json({
      date,
      totalClients: clients.length,
      totalRequests: total,
      clients: top,
    });
  } catch (err) {
    console.error('Clients API Error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
