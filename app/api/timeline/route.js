// app/api/timeline/route.js
import { getQuotaDate } from '../../../lib/utils';
import getRedis from '../../../lib/redis';

// 计算昨天的日期（YYYY-MM-DD 格式）
function getYesterdayDate() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().split('T')[0].replace(/-/g, '');
}

export async function GET() {
  try {
    const redis = getRedis();
    const date = getQuotaDate();
    const yesterday = getYesterdayDate();

    // 并行拉取今天和昨天每个小时的计数
    const todayPipeline = redis?.pipeline();
    const yesterdayPipeline = redis?.pipeline();
    
    for (let h = 0; h < 24; h++) {
      todayPipeline.get(`timeline:${date}:h${h}`);
      yesterdayPipeline.get(`timeline:${yesterday}:h${h}`);
    }
    
    const [todayCounts, yesterdayCounts] = await Promise.all([
      todayPipeline.exec(),
      yesterdayPipeline.exec(),
    ]);

    // 组装 24 小时时间线（带对比数据）
    const timeline = [];
    let todayTotal = 0;
    let yesterdayTotal = 0;
    
    for (let h = 0; h < 24; h++) {
      const todayCount = todayCounts[h] || 0;
      const yesterdayCount = yesterdayCounts[h] || 0;
      todayTotal += todayCount;
      yesterdayTotal += yesterdayCount;
      
      timeline.push({
        hour: h,
        label: `${String(h).padStart(2, '0')}:00`,
        today: todayCount,
        yesterday: yesterdayCount,
        change: yesterdayCount > 0 
          ? parseFloat((((todayCount - yesterdayCount) / yesterdayCount) * 100).toFixed(1))
          : (todayCount > 0 ? 100 : 0),
      });
    }

    // 计算总体增长率
    const overallChange = yesterdayTotal > 0
      ? parseFloat((((todayTotal - yesterdayTotal) / yesterdayTotal) * 100).toFixed(1))
      : (todayTotal > 0 ? 100 : 0);

    // 找出今天的峰值时段
    const peakHour = timeline.reduce((max, h) => h.today > max.today ? h : max, { today: 0 });

    return Response.json({
      date,
      yesterday,
      timezone: 'UTC+8 (Beijing)',
      timeline,
      summary: {
        todayTotal,
        yesterdayTotal,
        overallChange,
        peakHour: peakHour.hour,
        peakCount: peakHour.today,
      },
    });
  } catch (err) {
    console.error('Timeline API Error:', err);
    return Response.json({ error: '获取时间线数据失败' }, { status: 500 });
  }
}
