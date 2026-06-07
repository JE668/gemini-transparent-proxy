// app/api/quota/route.js
import { HIGH_QUOTA_MODELS } from '../../../lib/models';
import { getQuotaDate } from '../../../lib/utils';
import getRedis from '../../../lib/redis';

export async function GET() {
  try {
    const date = getQuotaDate();
    const globalUsed = await getRedis().get(`quota:global:${date}`) || 0;

    // 动态扫描 Redis 中所有 quota:{date}:* 的 key，发现实际使用的所有模型
    // Upstash Redis 不支持 keys()，必须用 scan()
    const discoveredModels = new Set();

    // 1) 从 HIGH_QUOTA_MODELS 获取已知模型（带 limit 信息）
    for (const model of HIGH_QUOTA_MODELS) {
    discoveredModels.add(model.id);
    }

    // 2) 用 scan 从 Redis 中发现实际使用过的模型（可能包含未知模型）
    // Upstash scan 返回 [cursor: string, keys: string[]]，cursor 为 "0" 时扫描完成
    let cursor = "0";
    do {
    const [nextCursor, keys] = await getRedis().scan(cursor, { match: `quota:${date}:*`, count: 100 });
    cursor = nextCursor;
    for (const key of keys) {
    // key 格式: quota:{date}:{modelId}
    const modelId = key.replace(`quota:${date}:`, '');
    if (modelId && modelId !== 'global') {
    discoveredModels.add(modelId);
    }
    }
    } while (cursor !== "0");

    const allModelIds = Array.from(discoveredModels);

    // 构建 limit 查找表
    const limitMap = {};
    for (const model of HIGH_QUOTA_MODELS) {
      limitMap[model.id] = model.limit || 1000;
    }

    // Pipeline 批量获取所有模型的配额和平均延迟
    const pipeline = getRedis().pipeline();
    for (const modelId of allModelIds) {
      pipeline.get(`quota:${date}:${modelId}`);
      pipeline.get(`avgLatency:${date}:${modelId}`);
    }
    // 批量获取状态码计数
    const statusCodes = [200, 400, 401, 403, 404, 429, 500, 502, 503];
    for (const code of statusCodes) {
      pipeline.get(`status:${date}:${code}`);
    }

    const results = await pipeline.exec();

    const quotaData = [];
    for (let i = 0; i < allModelIds.length; i++) {
      const modelId = allModelIds[i];
      const used = results[i * 2] || 0;
      const avgLatencyRaw = results[i * 2 + 1];
      const limit = limitMap[modelId] || 1500;
      const percent = parseFloat(((used / limit) * 100).toFixed(2));

      // 从 avgLatency key 读取: "count:avg" 格式
      let avgLatency = null;
      if (avgLatencyRaw && typeof avgLatencyRaw === 'string') {
        const parts = avgLatencyRaw.split(':');
        avgLatency = parseInt(parts[1]) || null;
      }

      quotaData.push({
        model: modelId,
        limit: limit,
        used: parseInt(used),
        percent: percent,
        avgLatency: avgLatency,
      });
    }

    // 按用量降序排列
    quotaData.sort((a, b) => b.used - a.used);

    // 计算全局错误率
    const statusOffset = allModelIds.length * 2;
    let totalRequests = 0;
    let totalErrors = 0;
    for (let i = 0; i < statusCodes.length; i++) {
      const count = parseInt(results[statusOffset + i]) || 0;
      totalRequests += count;
      if (statusCodes[i] >= 400) {
        totalErrors += count;
      }
    }
    const globalErrorRate = totalRequests > 0
      ? parseFloat(((totalErrors / totalRequests) * 100).toFixed(2))
      : 0;

    return Response.json({
      globalRequests: parseInt(globalUsed),
      globalErrorRate,
      data: quotaData,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Quota API Error:', err);
    return Response.json({
      error: '获取配额数据失败'
    }, { status: 500 });
  }
}
