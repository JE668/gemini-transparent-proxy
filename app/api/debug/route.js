// 调试 API：显示 Redis 中的所有 key（scan 分页遍历，Upstash 兼容）
import getRedis from '../../../lib/redis';
import { isDashboardAuthed, unauthorizedResponse } from '../../../lib/auth';

export async function GET(req) {
  if (!isDashboardAuthed(req)) return unauthorizedResponse();
  try {
    const redis = getRedis();
    if (!redis) {
      return Response.json({ error: 'Redis not configured' }, { status: 500 });
    }

    // ⚠️ Upstash 不支持 keys('*')（会报错），必须用 scan 分页遍历。
    // 返回 [cursor, keys]，cursor 为 "0" 时扫描完成。
    const allKeys = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, { match: '*', count: 200 });
      cursor = nextCursor;
      allKeys.push(...keys);
    } while (cursor !== '0');

    // 详情最多取前 500 个 key，避免大库时响应过大 / 函数超时
    const sampled = allKeys.slice(0, 500);

    const details = await Promise.all(
      sampled.map(async key => {
        const type = await redis.type(key);
        let value;
        if (type === 'string') {
          value = await redis.get(key);
        } else if (type === 'list') {
          const len = await redis.llen(key);
          value = `List (${len} items)`;
        } else if (type === 'set') {
          const len = await redis.scard(key);
          value = `Set (${len} items)`;
        } else if (type === 'zset') {
          const len = await redis.zcard(key);
          value = `ZSet (${len} items)`;
        } else if (type === 'hash') {
          const len = await redis.hlen(key);
          value = `Hash (${len} fields)`;
        } else {
          value = type;
        }
        return { key, type, value };
      })
    );

    return Response.json({
      total: allKeys.length,
      sampled: sampled.length,
      keys: details,
      now: new Date().toISOString(),
      beijingTime: new Date(new Date().getTime() + 8 * 60 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
