// app/api/dashboard/route.js
import { Redis } from '@upstash/redis';
import { HIGH_QUOTA_MODELS } from '../../../lib/models';
import { getQuotaDate } from '../../../lib/utils';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function GET() {
  try {
    const date = getQuotaDate();
    const pipeline = redis.pipeline();

    // 1. Global Quota & Status
    pipeline.get(`quota:global:${date}`);
    pipeline.get(`status:${date}:200`);
    pipeline.get(`status:${date}:500`);
    pipeline.get(`status:${date}:502`);
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
    // 6. Error Count
    pipeline.get(`status:${date}:500`);
    pipeline.get(`status:${date}:502`);

    // 7. Client Keys
    pipeline.smembers(`clients:${date}:keys`);

    const results = await pipeline.exec();
    let idx = 0;

    const globalUsed = results[idx++] || 0;
    const s200 = results[idx++] || 0;
    const s500 = results[idx++] || 0;
    const s502 = results[idx++] || 0;
    const totalRetries = results[idx++] || 0;

    const quotaData = [];
    for (const model of HIGH_QUOTA_MODELS) {
      const used = results[idx++] || 0;
      const latencies = results[idx++] || [];
      const limit = model.limit || 1000;
      const avgLatency = latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + parseInt(b), 0) / latencies.length)
        : null;

      quotaData.push({
        model: model.id,
        limit: limit,
        used: parseInt(used),
        percent: parseFloat(((used / limit) * 100).toFixed(2)),
        avgLatency,
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

    const e500 = results[idx++] || 0;
    const e502 = results[idx++] || 0;
    const totalErrorCount = parseInt(e500) + parseInt(e502);

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

    return Response.json({
      date,
      globalRequests: parseInt(globalUsed),
      globalErrorRate,
      totalRetries: parseInt(totalRetries),
      totalErrorCount,
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
