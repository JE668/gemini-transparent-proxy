// app/api/cherry/route.js
// Cherry 集群状态监控 — 单节点模式
// 显示当前 Vercel Edge Function 的运行状态
import getRedis from '../../../lib/redis';
import { getQuotaDate } from '../../../lib/utils';

export async function GET() {
  try {
    const redis = getRedis();
    const date = getQuotaDate();
    
    // 从 Redis 读取今天的运行数据
    const [totalRequests, latencyData, heartbeat] = await Promise.all([
      redis.get(`quota:global:${date}`) || 0,
      redis.get(`avgLatency:${date}:global`),
      redis.get('proxy:heartbeat') || 0,
    ]);
    
    // 解析平均延迟 (格式："count:avg")
    let avgLatency = 0;
    if (latencyData && typeof latencyData === 'string') {
      avgLatency = parseInt(latencyData.split(':')[1]) || 0;
    }
    
    // 单节点模式：Vercel Edge Function
    const node = {
      id: 'vercel-edge-1',
      name: 'Vercel Edge Function',
      status: heartbeat > 0 ? 'online' : 'unknown',
      latency: avgLatency,
      requests: parseInt(totalRequests) || 0,
      lastSeen: new Date().toISOString(),
      region: process.env.VERCEL_REGION || 'global',
      platform: 'Vercel Edge',
    };
    
    const cluster = {
      mode: 'single-node',
      status: node.status === 'online' ? 'healthy' : 'unknown',
      totalNodes: 1,
      onlineNodes: node.status === 'online' ? 1 : 0,
      nodes: [node],
      loadBalance: null, // 单节点无需负载均衡
    };

    return Response.json(cluster);
  } catch (error) {
    console.error('Cherry cluster status error:', error);
    return Response.json(
      { error: 'Failed to fetch cluster status' },
      { status: 500 }
    );
  }
}