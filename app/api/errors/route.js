// app/api/errors/route.js
import { getQuotaDate } from '../../../lib/utils';
import getRedis from '../../../lib/redis';

export async function GET() {
  try {
    const date = getQuotaDate();
    const rawEntries = await getRedis().lrange(`errors:${date}`, 0, 19);

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
  return Response.json({ error: '获取错误日志失败' }, { status: 500 });
  }
}
