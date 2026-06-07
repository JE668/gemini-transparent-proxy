import { NextResponse } from 'next/server';

// Cherry 集群状态监控
// 当前返回模拟数据（等待接入真实的 Cherry 集群监控源）

export async function GET() {
  try {
    const cluster = {
      status: 'healthy',
      totalNodes: 3,
      onlineNodes: 3,
      nodes: [
        { 
          id: 'cherry-1', 
          name: 'Cherry Node 1', 
          status: 'online', 
          latency: 45, 
          requests: 1234, 
          lastSeen: new Date().toISOString(),
          cpu: 45.2,
          memory: 62.8,
          connections: 128,
          successRate: 98.5,
        },
        { 
          id: 'cherry-2', 
          name: 'Cherry Node 2', 
          status: 'online', 
          latency: 52, 
          requests: 987, 
          lastSeen: new Date().toISOString(),
          cpu: 38.5,
          memory: 55.3,
          connections: 96,
          successRate: 99.1,
        },
        { 
          id: 'cherry-3', 
          name: 'Cherry Node 3', 
          status: 'online', 
          latency: 38, 
          requests: 1456, 
          lastSeen: new Date().toISOString(),
          cpu: 52.1,
          memory: 68.9,
          connections: 145,
          successRate: 97.8,
        },
      ],
      loadBalance: { algorithm: 'round-robin', distribution: [33, 32, 35] },
      metrics: {
        totalRequests24h: 3677,
        avgLatency: 45,
        errorRate: 0.02,
        uptime: 99.98,
        totalConnections: 369,
        avgCpu: 45.3,
        avgMemory: 62.3,
      },
      history: {
        labels: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00'],
        requests: [450, 380, 520, 680, 720, 927],
        latency: [42, 38, 45, 52, 48, 45],
      },
    };

    return NextResponse.json(cluster);
  } catch (error) {
    console.error('Cherry cluster status error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch cluster status' },
      { status: 500 }
    );
  }
}