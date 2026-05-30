// app/api/quota/route.js
import { HIGH_QUOTA_MODELS } from '../../../lib/models';
import { getQuotaDate } from '../../../lib/utils';
import redis from '../../../lib/redis';

export async function GET() {
 try {
 const date = getQuotaDate();
 const globalUsed = await redis.get(`quota:global:${date}`) || 0;

 // Pipeline 批量获取所有模型的配额和平均延迟
 const pipeline = redis.pipeline();
 for (const model of HIGH_QUOTA_MODELS) {
 pipeline.get(`quota:${date}:${model.id}`);
 pipeline.get(`avgLatency:${date}:${model.id}`);
 }
 // 批量获取状态码计数
 const statusCodes = [200, 400, 401, 403, 404, 429, 500, 502, 503];
 for (const code of statusCodes) {
 pipeline.get(`status:${date}:${code}`);
 }

 const results = await pipeline.exec();

 const quotaData = [];
 for (let i = 0; i < HIGH_QUOTA_MODELS.length; i++) {
 const model = HIGH_QUOTA_MODELS[i];
 const used = results[i * 2]?.[1] || 0;
 const avgLatencyRaw = results[i * 2 + 1]?.[1];
 const limit = model.limit || 1000;
 const percent = parseFloat(((used / limit) * 100).toFixed(2));

 // 从 avgLatency key 读取: "count:avg" 格式
 let avgLatency = null;
 if (avgLatencyRaw && typeof avgLatencyRaw === 'string') {
 const parts = avgLatencyRaw.split(':');
 avgLatency = parseInt(parts[1]) || null;
 }

 quotaData.push({
 model: model.id,
 limit: limit,
 used: parseInt(used),
 percent: percent,
 avgLatency: avgLatency,
 });
 }

 // 计算全局错误率
 const statusOffset = HIGH_QUOTA_MODELS.length * 2;
 let totalRequests = 0;
 let totalErrors = 0;
 for (let i = 0; i < statusCodes.length; i++) {
 const count = parseInt(results[statusOffset + i]?.[1]) || 0;
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
