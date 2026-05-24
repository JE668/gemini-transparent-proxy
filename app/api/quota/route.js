// app/api/quota/route.js
import { Redis } from '@upstash/redis';
import { HIGH_QUOTA_MODELS } from '../../../lib/models';
import { getQuotaDate } from '../../../lib/utils';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function GET() {
  try {
    const date = getQuotaDate();
    const globalUsed = await redis.get(`quota:global:${date}`) || 0;
    const quotaData = [];

    for (const model of HIGH_QUOTA_MODELS) {
      const used = await redis.get(`quota:${date}:${model.id}`) || 0;
      const limit = model.limit || 1000;
      const percent = parseFloat(((used / limit) * 100).toFixed(2));

      const latencies = await redis.lrange(`latency:${model.id}`, 0, -1);
      const avgLatency = latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + parseInt(b), 0) / latencies.length)
        : null;

      const successCount = await redis.get(`status:${date}:200`) || 0;
      const errorCount = (await redis.get(`status:${date}:500`) || 0)
        + (await redis.get(`status:${date}:502`) || 0);
      const total = parseInt(successCount) + parseInt(errorCount);
      const errorRate = total > 0
        ? parseFloat(((parseInt(errorCount) / total) * 100).toFixed(2))
        : 0;

      quotaData.push({
        model: model.id,
        limit: limit,
        used: parseInt(used),
        percent: percent,
        avgLatency: avgLatency,
        errorRate: errorRate
      });
    }

    return Response.json({
      globalRequests: parseInt(globalUsed),
      data: quotaData,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Quota API Error:', err);
    return Response.json({
      error: '获取 Redis 数据失败: ' + err.message
    }, { status: 500 });
  }
}
