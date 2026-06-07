import { NextResponse } from 'next/server';
import { Redis } from 'ioredis';

// 初始化 Redis 连接（延迟连接，按需创建）
let redisClient = null;

function getRedisClient() {
  if (!redisClient && process.env.REDIS_URL) {
    redisClient = new Redis(process.env.REDIS_URL, {
      tls: process.env.REDIS_URL.includes('upstash') ? {} : undefined,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
    });
  }
  return redisClient;
}

export async function GET() {
  const redis = getRedisClient();
  
  try {
    // 如果没有 Redis，返回模拟数据
    if (!redis) {
      return NextResponse.json({
        status: 'healthy',
        totalNodes: 3,
        onlineNodes: 3,
        nodes: [
          { id: 'cherry-1', name: 'Cherry Node 1', status: 'online', latency: 45, requests: 1234, lastSeen: new Date().toISOString() },
          { id: 'cherry-2', name: 'Cherry Node 2', status: 'online', latency: 52, requests: 987, lastSeen: new Date().toISOString() },
          { id: 'cherry-3', name: 'Cherry Node 3', status: 'online', latency: 38, requests: 1456, lastSeen: new Date().toISOString() },
        ],
        loadBalance: { algorithm: 'round-robin', distribution: [33, 32, 35] },
        metrics: {
          totalRequests24h: 3677,
          avgLatency: 45,
          errorRate: 0.02,
          uptime: 99.98,
        },
        history: {
          labels: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00'],
          requests: [450, 380, 520, 680, 720, 927],
          latency: [42, 38, 45, 52, 48, 45],
        },
      });
    }

    // 从 Redis 读取 Cherry 集群数据
    
    // 1. 获取所有节点 ID
    const nodeIds = await redis.smembers('cherry:nodes') || [];
    
    if (nodeIds.length === 0) {
      // 没有节点数据，返回空状态
      return NextResponse.json({
        status: 'unknown',
        totalNodes: 0,
        onlineNodes: 0,
        nodes: [],
        loadBalance: { algorithm: 'unknown', distribution: [] },
        metrics: { totalRequests24h: 0, avgLatency: 0, errorRate: 0, uptime: 0 },
        history: { labels: [], requests: [], latency: [] },
      });
    }

    // 2. 并行获取每个节点的详细信息
    const nodes = await Promise.all(
      nodeIds.map(async (nodeId) => {
        const [status, latency, requests, lastSeen, cpu, memory, connections, successRate] = await Promise.all([
          redis.get(`cherry:node:${nodeId}:status`),
          redis.get(`cherry:node:${nodeId}:latency`),
          redis.get(`cherry:node:${nodeId}:requests`),
          redis.get(`cherry:node:${nodeId}:last_seen`),
          redis.get(`cherry:node:${nodeId}:cpu`),
          redis.get(`cherry:node:${nodeId}:memory`),
          redis.get(`cherry:node:${nodeId}:connections`),
          redis.get(`cherry:node:${nodeId}:success_rate`),
        ]).catch(() => []);

        return {
          id: nodeId,
          name: `Cherry ${nodeId.replace('cherry-', '')}`,
          status: status || 'unknown',
          latency: parseInt(latency) || 0,
          requests: parseInt(requests) || 0,
          lastSeen: lastSeen || new Date().toISOString(),
          // 新增监控指标
          cpu: parseFloat(cpu) || 0,
          memory: parseFloat(memory) || 0,
          connections: parseInt(connections) || 0,
          successRate: parseFloat(successRate) || 100,
        };
      })
    );

    // 3. 计算集群整体状态
    const onlineNodes = nodes.filter(n => n.status === 'online').length;
    const totalNodes = nodes.length;
    
    const status = onlineNodes === totalNodes ? 'healthy' :
                   onlineNodes > 0 ? 'degraded' : 'unhealthy';

    // 4. 计算负载均衡分布
    const totalRequests = nodes.reduce((sum, n) => sum + n.requests, 0);
    const distribution = nodes.map(n => 
      totalRequests > 0 ? Math.round((n.requests / totalRequests) * 100) : 0
    );

    // 5. 计算集群指标
    const avgLatency = nodes.length > 0 
      ? Math.round(nodes.reduce((sum, n) => sum + n.latency, 0) / nodes.length)
      : 0;
    
    const avgSuccessRate = nodes.length > 0
      ? nodes.reduce((sum, n) => sum + n.successRate, 0) / nodes.length
      : 100;
    
    const totalConnections = nodes.reduce((sum, n) => sum + n.connections, 0);
    const avgCpu = nodes.length > 0
      ? (nodes.reduce((sum, n) => sum + n.cpu, 0) / nodes.length).toFixed(1)
      : 0;
    
    const avgMemory = nodes.length > 0
      ? (nodes.reduce((sum, n) => sum + n.memory, 0) / nodes.length).toFixed(1)
      : 0;

    // 6. 获取 24 小时历史数据（从 Redis time series）
    const historyLabels = [];
    const historyRequests = [];
    const historyLatency = [];
    
    for (let hour = 0; hour < 24; hour += 4) {
      const timeKey = `cherry:history:${hour}:00`;
      const [reqCount, lat] = await Promise.all([
        redis.get(`${timeKey}:requests`),
        redis.get(`${timeKey}:latency`),
      ]).catch(() => [0, 0]);
      
      historyLabels.push(`${hour.toString().padStart(2, '0')}:00`);
      historyRequests.push(parseInt(reqCount) || 0);
      historyLatency.push(parseInt(lat) || 0);
    }

    const cluster = {
      status,
      totalNodes,
      onlineNodes,
      nodes,
      loadBalance: {
        algorithm: 'round-robin', // 或者从 Redis 读取：await redis.get('cherry:lb:algorithm')
        distribution,
      },
      metrics: {
        totalRequests24h: totalRequests,
        avgLatency,
        errorRate: (100 - avgSuccessRate).toFixed(2),
        uptime: calculateUptime(nodes), // 计算正常运行时间百分比
        totalConnections,
        avgCpu: parseFloat(avgCpu),
        avgMemory: parseFloat(avgMemory),
      },
      history: {
        labels: historyLabels,
        requests: historyRequests,
        latency: historyLatency,
      },
    };

    return NextResponse.json(cluster);
  } catch (error) {
    console.error('Cherry cluster status error:', error.message);
    return NextResponse.json(
      { 
        error: 'Failed to fetch cluster status',
        details: error.message,
        status: 'unknown',
        totalNodes: 0,
        onlineNodes: 0,
        nodes: [],
        loadBalance: { algorithm: 'unknown', distribution: [] },
        metrics: { totalRequests24h: 0, avgLatency: 0, errorRate: 0, uptime: 0 },
        history: { labels: [], requests: [], latency: [] },
      },
      { status: 500 }
    );
  }
}

// 计算正常运行时间百分比（基于在线节点比例）
function calculateUptime(nodes) {
  if (nodes.length === 0) return 0;
  const onlineNodes = nodes.filter(n => n.status === 'online').length;
  return ((onlineNodes / nodes.length) * 100).toFixed(2);
}