export const runtime = 'edge';
import { Redis } from '@upstash/redis';
import { HIGH_QUOTA_MODELS } from '../../../lib/models';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function GET() {
  try {
    const date = new Date().toISOString().split('T')[0];
    
    // 获取全局请求数用于调试
    const globalUsed = await redis.get(`quota:global:${date}`) || 0;
    console.log(`[Quota API] Global usage for ${date}: ${globalUsed}`);

    const quotaData = [];

    for (const model of HIGH_QUOTA_MODELS) {
      const used = await redis.get(`quota:${date}:${model.id}`) || 0;
      const limit = model.limit || 1000; 
      const percent = parseFloat(((used / limit) * 100).toFixed(2));
      
      quotaData.push({
        model: model.id,
        limit: limit,
        used: parseInt(used),
        percent: percent,
      });
    }

    return Response.json({
      globalRequests: parseInt(globalUsed),
      data: quotaData
    });
  } catch (err) {
    console.error('Quota API Error:', err);
    return Response.json({ error: '获取 Redis 数据失败: ' + err.message }, { status: 500 });
  }
}
