// app/api/timeline/route.js
import { Redis } from '@upstash/redis';
import { getQuotaDate } from '../../../lib/utils';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function GET() {
  try {
    const date = getQuotaDate();

    // 获取今天有数据的小时集合
    const activeHours = await redis.smembers(`timeline:${date}:hours`);

    // 并行拉取每个小时的计数
    const pipeline = redis.pipeline();
    for (let h = 0; h < 24; h++) {
      pipeline.get(`timeline:${date}:h${h}`);
    }
    const counts = await pipeline.exec();

    // 组装 24 小时时间线
    const timeline = [];
    for (let h = 0; h < 24; h++) {
      timeline.push({
        hour: h,
        label: `${String(h).padStart(2, '0')}:00`,
        count: counts[h] || 0,
      });
    }

    return Response.json({
      date,
      timezone: 'UTC+8 (Beijing)',
      timeline,
    });
  } catch (err) {
    console.error('Timeline API Error:', err);
    return Response.json({ error: '获取时间线数据失败' }, { status: 500 });
  }
}
