// app/api/clients/route.js
import { getQuotaDate } from '../../../lib/utils';
import getRedis from '../../../lib/redis';

export async function GET() {
  try {
    const date = getQuotaDate();
    const keys = await getRedis().smembers(`clients:${date}:keys`);

    if (!keys || keys.length === 0) {
      return Response.json({ date, clients: [] });
    }

    // Pipeline 批量获取每个 key 的计数
    const pipeline = getRedis().pipeline();
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
    return Response.json({ error: '获取客户端统计失败' }, { status: 500 });
  }
}
