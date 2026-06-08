#!/usr/bin/env node
// 测试 Redis 连接和数据
import { Redis } from '@upstash/redis';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env.local') });

async function testRedis() {
  console.log('🔍 测试 Redis 连接...\n');
  
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) {
    console.error('❌ 缺少环境变量：');
    console.error(`   UPSTASH_REDIS_REST_URL: ${url || '未设置'}`);
    console.error(`   UPSTASH_REDIS_REST_TOKEN: ${token || '未设置'}`);
    process.exit(1);
  }
  
  console.log('✅ 环境变量已配置');
  console.log(`   URL: ${url}`);
  
  const redis = new Redis({ url, token });
  
  try {
    // 测试连接
    const ping = await redis.ping();
    console.log(`\n✅ Redis 连接成功：${ping}`);
    
    // 获取今天的日期
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    
    // 检查是否有数据
    console.log('\n📊 检查今日数据...');
    
    const totalRequests = await redis.get(`quota:global:${today}`);
    console.log(`   今日请求数：${totalRequests || '0'}`);
    
    const heartbeat = await redis.get('proxy:heartbeat');
    console.log(`   心跳计数：${heartbeat || '0'}`);
    
    const clientKeys = await redis.smembers(`clients:${today}:keys`);
    console.log(`   客户端数：${clientKeys?.length || 0}`);
    
    // 检查所有 key
    console.log('\n📁 查找所有相关 key...');
    const pattern = `quota:*`;
    const keys = await redis.keys(pattern);
    console.log(`   quota:* 相关 key: ${keys.length} 个`);
    if (keys.length > 0) {
      keys.forEach(k => console.log(`     - ${k}`));
    }
    
    // 获取最近的请求
    const recent = await redis.lrange(`recent:${today}`, 0, 4);
    if (recent.length > 0) {
      console.log('\n📝 最近 5 条请求：');
      recent.forEach((r, i) => {
        console.log(`   ${i+1}. ${r}`);
      });
    } else {
      console.log('\n⚠️  今日无请求数据');
    }
    
    // 检查是否有历史数据
    const allKeys = await redis.keys('*');
    console.log(`\n📂 Redis 中所有 key: ${allKeys.length} 个`);
    if (allKeys.length <= 20) {
      allKeys.forEach(k => console.log(`   - ${k}`));
    }
    
  } catch (error) {
    console.error('\n❌ Redis 测试失败：', error.message);
    process.exit(1);
  }
}

testRedis();