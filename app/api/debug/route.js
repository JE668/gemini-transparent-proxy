// 调试 API：显示 Redis 中的所有 key
import getRedis from '../../../lib/redis';

export async function GET() {
  try {
    const redis = getRedis();
    const allKeys = await redis.keys('*');
    
    const details = await Promise.all(
      allKeys.map(async key => {
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
      keys: details,
      now: new Date().toISOString(),
      beijingTime: new Date(new Date().getTime() + 8 * 60 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}