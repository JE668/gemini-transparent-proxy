// app/api/clients/route.js
import { getQuotaDate } from '../../../lib/utils';
import getRedis from '../../../lib/redis';

// 解析 User-Agent 识别客户端类型
function parseUserAgent(ua) {
  if (!ua || ua === 'unknown') return { type: '未知', icon: '🔌' };
  if (ua.includes('Postman')) return { type: 'Postman', icon: '🔌' };
  if (ua.includes('curl')) return { type: 'curl', icon: '💻' };
  if (ua.includes('python-requests')) return { type: 'Python', icon: '🐍' };
  if (ua.includes('node-fetch')) return { type: 'Node.js', icon: '🟢' };
  if (ua.includes('axios')) return { type: 'Axios', icon: '📦' };
  if (ua.includes('Go-http-client')) return { type: 'Go', icon: '🔵' };
  if (ua.includes('Java')) return { type: 'Java', icon: '☕' };
  if (ua.includes('Mozilla/5.0')) {
    if (ua.includes('Chrome')) return { type: 'Browser (Chrome)', icon: '🌐' };
    if (ua.includes('Firefox')) return { type: 'Browser (Firefox)', icon: '🦊' };
    if (ua.includes('Safari')) return { type: 'Browser (Safari)', icon: '🧭' };
  }
  return { type: '其他', icon: '🔌' };
}

// 简化的 IP 显示（隐藏后两段）
function maskIP(ip) {
  if (!ip || ip === 'unknown') return '***';
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.**.**`;
  }
  return ip.slice(0, 8) + '***';
}

export async function GET() {
  try {
    const redis = getRedis();
    const date = getQuotaDate();
    const keys = await redis?.smembers(`clients:${date}:keys`);

    if (!keys || keys.length === 0) {
      return Response.json({ date, clients: [] });
    }

    // Pipeline 批量获取每个 key 的计数和详细信息
    const countPipeline = redis.pipeline();
    const infoPipeline = redis.pipeline();
    
    keys.forEach(k => {
      countPipeline.get(`clients:${date}:${k}`);
      infoPipeline.hgetall(`client:info:${k}`);
    });
    
    const [counts, infos] = await Promise.all([
      countPipeline.exec(),
      infoPipeline.exec(),
    ]);

    const clients = keys.map((k, i) => {
      const info = infos[i] || {};
      const uaInfo = parseUserAgent(info.ua);
      
      return {
        fingerprint: k,
        requests: counts[i] || 0,
        ip: maskIP(info.ip),
        ipFull: info.ip,
        ua: uaInfo.type,
        uaIcon: uaInfo.icon,
        lastSeen: info.lastSeen,
      };
    });

    // 按请求数降序，取 Top 10
    clients.sort((a, b) => b.requests - a.requests);
    const top = clients.slice(0, 10);

    const total = clients.reduce((s, c) => s + c.requests, 0);

    return Response.json({
      date,
      totalClients: clients.length,
      totalRequests: total,
      clients: top,
    });
  } catch (err) {
    console.error('Clients API Error:', err);
    return Response.json({ error: '获取客户端统计失败' }, { status: 500 });
  }
}
