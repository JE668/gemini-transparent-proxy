// app/api/dashboard/route.js
import { HIGH_QUOTA_MODELS } from '../../../lib/models';
import { getQuotaDate } from '../../../lib/utils';
import getRedis from '../../../lib/redis';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET() {
  try {
    const redis = getRedis();
    if (!redis) {
      return Response.json({ error: 'Redis not configured' }, { status: 500 });
    }
    const date = getQuotaDate();
    const now = new Date();
    const currentHour = (now.getUTCHours() + 8) % 24; // 北京时间小时
    const hoursElapsed = currentHour + 1; // 从 0 点到现在经过的小时数
    
    const pipeline = redis.pipeline();

    // 1. Global Quota & Status
    pipeline.get(`quota:global:${date}`);
    pipeline.get(`status:${date}:200`);
    pipeline.get(`status:${date}:500`);
    pipeline.get(`status:${date}:502`);
    pipeline.get(`status:${date}:400`);
    pipeline.get(`status:${date}:401`);
    pipeline.get(`status:${date}:429`);
    pipeline.get(`retries:${date}`);

    // 2. Per-Model Quota & Latency
    for (const model of HIGH_QUOTA_MODELS) {
      pipeline.get(`quota:${date}:${model.id}`);
      pipeline.lrange(`latency:${model.id}`, 0, -1);
    }

    // 3. Timeline (24h)
    for (let h = 0; h < 24; h++) {
      pipeline.get(`timeline:${date}:h${h}`);
    }

    // 4. Recent Requests
    pipeline.lrange(`recent:${date}`, 0, 29);
    // 5. Error Stream (Maintain 100 depth)
    pipeline.lrange(`errors:${date}`, 0, 99);
    
    // 7. Client Keys
    pipeline.smembers(`clients:${date}:keys`);

    const results = await pipeline.exec();
    let idx = 0;

    const globalUsed = results[idx++] || 0;
    const s200 = results[idx++] || 0;
    const s500 = results[idx++] || 0;
    const s502 = results[idx++] || 0;
    const s400 = results[idx++] || 0;
    const s401 = results[idx++] || 0;
    const s429 = results[idx++] || 0;
    const totalRetries = results[idx++] || 0;

    const quotaData = [];
        for (const model of HIGH_QUOTA_MODELS) {
          const used = results[idx++] || 0;
          const latencies = results[idx++] || [];
          const limit = model.limit || 1000;
          const avgLatency = latencies.length > 0
            ? Math.round(latencies.reduce((a, b) => a + parseInt(b), 0) / latencies.length)
            : null;
      
          // 单个模型的配额预测
          const modelHourlyRate = parseInt(used) / hoursElapsed;
          const modelRemaining = limit - parseInt(used);
          const modelHoursUntil = modelHourlyRate > 0 ? modelRemaining / modelHourlyRate : Infinity;
          const modelMinutesUntil = modelHoursUntil * 60;
      
          quotaData.push({
            model: model.id,
            limit: limit,
            used: parseInt(used),
            percent: parseFloat(((used / limit) * 100).toFixed(2)),
            avgLatency,
            prediction: {
              exhausted: modelRemaining <= 0,
              minutes: modelRemaining <= 0 ? 0 : Math.round(modelMinutesUntil),
              rate: Math.round(modelHourlyRate),
              remaining: Math.max(0, modelRemaining),
            },
          });
        }

    const timeline = [];
    for (let h = 0; h < 24; h++) {
      timeline.push({
        hour: h,
        label: `${String(h).padStart(2, '0')}:00`,
        count: results[idx++] || 0,
      });
    }

    const recentRaw = results[idx++] || [];
    const recent = recentRaw.map(entry => (typeof entry === 'string' ? JSON.parse(entry) : entry)).filter(Boolean);

    const errorsRaw = results[idx++] || [];
    const errors = errorsRaw.map(entry => (typeof entry === 'string' ? JSON.parse(entry) : entry)).filter(Boolean);
    
    // 错误分类统计
    const errorBreakdown = {
      client4xx: (parseInt(s400) || 0) + (parseInt(s401) || 0) + (parseInt(s429) || 0),
      server5xx: (parseInt(s500) || 0) + (parseInt(s502) || 0),
      timeout: errors.filter(e => e.status === 504 || (e.message && e.message.includes('timeout'))).length,
    };

    const clientKeys = results[idx++] || [];

    // Second pass for client counts
    let clients = [];
    if (clientKeys.length > 0) {
      const clientPipeline = redis.pipeline();
      clientKeys.forEach(k => clientPipeline.get(`clients:${date}:${k}`));
      const clientCounts = await clientPipeline.exec();

      clients = clientKeys.map((k, i) => ({
        fingerprint: k,
        requests: clientCounts[i] || 0,
      })).sort((a, b) => b.requests - a.requests);
    }

    const totalClients = clients.length;
    const totalClientRequests = clients.reduce((s, c) => s + c.requests, 0);
    const topClients = clients.slice(0, 10);

    // Aggregate Error Rate
    const totalStatus = parseInt(s200) + parseInt(s500) + parseInt(s502);
    const totalErrors = parseInt(s500) + parseInt(s502);
    const globalErrorRate = totalStatus > 0 ? parseFloat(((totalErrors / totalStatus) * 100).toFixed(2)) : 0;
    const totalErrorCount = parseInt(s500) + parseInt(s502);
    
    // 配额预测：基于当前使用速率预测耗尽时间
    const globalLimit = HIGH_QUOTA_MODELS.reduce((sum, m) => sum + (m.limit || 1000), 0); // 简单求和作为参考
    const hourlyRate = globalUsed / hoursElapsed;
    const remaining = globalLimit - globalUsed;
    const hoursUntilExhaustion = hourlyRate > 0 ? remaining / hourlyRate : Infinity;
    const minutesUntilExhaustion = hoursUntilExhaustion * 60;
    
    const quotaPrediction = {
      exhausted: remaining <= 0,
      minutes: remaining <= 0 ? 0 : Math.round(minutesUntilExhaustion),
      rate: Math.round(hourlyRate),
      remaining: Math.max(0, remaining),
      hoursElapsed,
    };

    return Response.json({
      date,
      globalRequests: parseInt(globalUsed),
      globalErrorRate,
      totalRetries: parseInt(totalRetries),
      totalErrorCount,
      errorBreakdown,
      quotaPrediction,
      quota: {
        data: quotaData,
      },
      timeline: {
        timeline,
      },
      recent: {
        recent,
      },
      errors: {
        count: totalErrorCount,
        errors,
      },
      clients: {
        totalClients,
        totalRequests: totalClientRequests,
        clients: topClients,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Dashboard Aggregate API Error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
