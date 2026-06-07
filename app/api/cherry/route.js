import { NextResponse } from 'next/server';

// Cherry 集群状态监控
// 返回各节点的健康状态、延迟、请求数

export async function GET() {
  try {
    // 临时模拟数据（后续可接入真实的 Cherry 集群监控）
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
        },
        {
          id: 'cherry-2',
          name: 'Cherry Node 2',
          status: 'online',
          latency: 52,
          requests: 987,
          lastSeen: new Date().toISOString(),
        },
        {
          id: 'cherry-3',
          name: 'Cherry Node 3',
          status: 'online',
          latency: 38,
          requests: 1456,
          lastSeen: new Date().toISOString(),
        },
      ],
      loadBalance: {
        algorithm: 'round-robin',
        distribution: [33, 32, 35], // 百分比
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