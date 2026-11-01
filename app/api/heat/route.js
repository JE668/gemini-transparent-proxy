import { isDashboardAuthed, unauthorizedResponse } from '../../../lib/auth';
// app/api/heat/route.js
// 多维热力图读取端点：返回「小时 × 维度」交叉计数矩阵。
//
// 数据由 lib/telemetry.js 的 buildTelemetryEvents 写入（Vercel + CF Worker 共用）：
//   heat:status:{date}:h{hour}  → Hash<statusCode, count>
//   heat:latency:{date}:h{hour} → Hash<latencyBucket, count>
//   heat:model:{date}:h{hour}   → Hash<modelId, count>
//
// 读取方式：对 24 小时做 pipeline.hgetall，每个 Hash 还原一行，得到 24×N 矩阵。
// 端点输出固定行（状态码 / 延迟桶），模型行为动态发现（按出现次数排序取前 N）。
import { getQuotaDate } from '../../../lib/utils';
import getRedis from '../../../lib/redis';
import { LATENCY_BUCKETS, HEAT_STATUS_CODES } from '../../../lib/telemetry';

export async function GET(req) {
  if (!isDashboardAuthed(req)) return unauthorizedResponse();
  try {
    const redis = getRedis();
    if (!redis) {
      return Response.json({
        date: getQuotaDate(),
        redisEnabled: false,
        status: { rows: [], hours: [] },
        latency: { rows: [], hours: [] },
        models: { rows: [], hours: [] },
      });
    }

    const date = getQuotaDate();

    // 并行拉取 24 小时 × 3 个维度的 Hash
    const pipeline = redis.pipeline();
    for (let h = 0; h < 24; h++) {
      pipeline.hgetall(`heat:status:${date}:h${h}`);
      pipeline.hgetall(`heat:latency:${date}:h${h}`);
      pipeline.hgetall(`heat:model:${date}:h${h}`);
    }
    const results = await pipeline.exec();

    const hours = Array.from({ length: 24 }, (_, h) => h);
    const statusBuckets = new Map(); // field → 24 长度数组
    const latencyBuckets = new Map();
    const modelBuckets = new Map();

    for (let h = 0; h < 24; h++) {
      const statusHash = results[h * 3] || {};
      const latencyHash = results[h * 3 + 1] || {};
      const modelHash = results[h * 3 + 2] || {};

      for (const [field, count] of Object.entries(statusHash)) {
        if (!statusBuckets.has(field)) statusBuckets.set(field, new Array(24).fill(0));
        statusBuckets.get(field)[h] = Number(count) || 0;
      }
      for (const [field, count] of Object.entries(latencyHash)) {
        if (!latencyBuckets.has(field)) latencyBuckets.set(field, new Array(24).fill(0));
        latencyBuckets.get(field)[h] = Number(count) || 0;
      }
      for (const [field, count] of Object.entries(modelHash)) {
        if (!modelBuckets.has(field)) modelBuckets.set(field, new Array(24).fill(0));
        modelBuckets.get(field)[h] = Number(count) || 0;
      }
    }

    // 状态码行：按固定顺序输出（缺失补 0），只保留有数据的
    const statusRows = HEAT_STATUS_CODES
      .filter(code => statusBuckets.has(String(code)))
      .map(code => ({
        id: String(code),
        label: String(code),
        values: statusBuckets.get(String(code)),
      }));

    // 延迟行：按桶定义顺序输出（缺失补 0）
    const latencyRows = LATENCY_BUCKETS
      .filter(b => latencyBuckets.has(b.id))
      .map(b => ({
        id: b.id,
        label: b.label,
        values: latencyBuckets.get(b.id),
      }));

    // 模型行：动态发现，按总量降序取前 8（避免模型过多导致热力图过密）
    const modelRows = Array.from(modelBuckets.entries())
      .map(([id, values]) => ({
        id,
        label: id.replace('models/', ''),
        values,
        total: values.reduce((s, v) => s + v, 0),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8)
      .map(({ id, label, values }) => ({ id, label, values }));

    return Response.json({
      date,
      redisEnabled: true,
      status: { rows: statusRows, hours },
      latency: { rows: latencyRows, hours },
      models: { rows: modelRows, hours },
    });
  } catch (err) {
    console.error('Heat API Error:', err);
    return Response.json({ error: '获取热力图数据失败' }, { status: 500 });
  }
}
