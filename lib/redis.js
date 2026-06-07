// lib/redis.js
// Redis 单例：所有模块共用一个实例，避免重复创建连接

import { Redis } from '@upstash/redis';

let _redis = null;

export function getRedis() {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error('缺少 UPSTASH_REDIS_REST_URL 或 UPSTASH_REDIS_REST_TOKEN 环境变量');
    }
    _redis = new Redis({ url, token });
  }
  return _redis;
}

// 兼容旧代码的默认导出
export default getRedis;
