import { isDashboardAuthed, unauthorizedResponse } from '../../../lib/auth';
// app/api/timeline/route.js
import { getQuotaDate, getPreviousQuotaDate } from '../../../lib/utils';
import getRedis from '../../../lib/redis';

export async function GET(req) {
  if (!isDashboardAuthed(req)) return unauthorizedResponse();
  try {
    // ⚠️ Redis 未配置时提前返回：旧实现 `redis?.pipeline()` 得到 undefined，
    //    随后 `todayPipeline.get(...)` 直接抛 TypeError → 端点 500。
    const redis = getRedis();
    if (!redis) {
      return Response.json({
        date: getQuotaDate(),
        yesterday: getPreviousQuotaDate(),
        timezone: 'UTC+8 (Beijing)',
        redisEnabled: false,
        timeline: [],
        summary: { todayTotal: 0, yesterdayTotal: 0, overallChange: 0, peakHour: 0, peakCount: 0 },
      });
    }

    const date = getQuotaDate();
    // ⚠️ 昨天必须是「上一个配额日」（同样以北京时间 15:00 为界），
    //    且格式必须与写入端的 `timeline:${date}:h${h}` 一致（YYYY-MM-DD）。
    //    旧实现用自然日减一天并去掉连字符（YYYYMMDD），
    //    与写入格式永远对不上 → 昨天一栏恒为 0。
    const yesterday = getPreviousQuotaDate();

    // 并行拉取今天和昨天每个小时的计数
    const todayPipeline = redis.pipeline();
    const yesterdayPipeline = redis.pipeline();

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
