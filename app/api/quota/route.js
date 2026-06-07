// app/api/quota/route.js
import { HIGH_QUOTA_MODELS } from '../../../lib/models';
import { getQuotaDate } from '../../../lib/utils';
import getRedis from '../../../lib/redis';

export async function GET() {
  try {
    const date = getQuotaDate();
    const globalUsed = await getRedis()?.get(`quota:global:${date}`) || 0;

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
    const [nextCursor, keys] = await getRedis()?.scan(cursor, { match: `quota:${date}:*`, count: 100 });
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
    const pipeline = getRedis()?.pipeline();
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

    // 错误告警：根据错误率判断严重性
    const errorAlert = {
      level: globalErrorRate > 10 ? 'critical' : globalErrorRate > 5 ? 'warning' : 'normal',
      rate: globalErrorRate,
      totalRequests,
      totalErrors,
      message: globalErrorRate > 10 ? '严重：错误率超过 10%' : globalErrorRate > 5 ? '警告：错误率超过 5%' : '正常'
    };

    // 检测 unknown-model
    const unknownModels = quotaData.filter(d => d.model === 'unknown-model' || d.model.includes('unknown'));
    const unknownModelAlert = unknownModels.length > 0 ? {
      count: unknownModels.length,
      totalUsed: unknownModels.reduce((s, d) => s + d.used, 0),
      models: unknownModels.map(d => d.model),
    } : null;
    
    // 如果有 unknown-model，提升告警级别
    if (unknownModelAlert && errorAlert.level === 'normal') {
      errorAlert.level = 'warning';
      errorAlert.message = '警告：发现未配置模型';
    }

    // Webhook 告警通知：当错误级别从正常变为警告/严重时发送
    const webhookUrl = process.env.ERROR_WEBHOOK_URL;
    const webhookType = process.env.ERROR_WEBHOOK_TYPE; // 'dingtalk' or 'telegram'
    const quietHours = process.env.QUIET_HOURS_ENABLED === 'true'; // 是否启用静默时段
    const quietStart = parseInt(process.env.QUIET_HOURS_START || '22'); // 静默开始时间（小时）
    const quietEnd = parseInt(process.env.QUIET_HOURS_END || '8'); // 静默结束时间（小时）
    
    if (errorAlert.level !== 'normal' && webhookUrl) {
      // 从 Redis 读取上次告警级别
      const redis = getRedis();
      const lastAlertKey = `alert:last_error_level:${new Date().toDateString()}`;
      const lastLevel = await redis?.get(lastAlertKey);
      
      // 只有当级别升级时才发送（避免重复通知）
      const levelPriority = { normal: 0, warning: 1, critical: 2 };
      const shouldNotify = !lastLevel || levelPriority[errorAlert.level] > levelPriority[lastLevel];
      
      // 检查是否在静默时段（仅针对 warning 级别，critical 始终发送）
      const now = new Date();
      const beijingHour = (now.getUTCHours() + 8) % 24;
      const isQuietHours = quietHours && 
        ((quietStart >= quietEnd && (beijingHour >= quietStart || beijingHour < quietEnd)) ||
         (quietStart < quietEnd && beijingHour >= quietStart && beijingHour < quietEnd));
      
      // 静默时段只发送 critical 告警
      const skipForQuiet = isQuietHours && errorAlert.level === 'warning';
      
      if (shouldNotify && !skipForQuiet && redis) {
        // 发送 Webhook
        try {
          const alertBody = {
            content: {
              title: '🚨 Gemini 代理错误告警',
              text: `**错误率告警**\n\n` +
                    `当前错误率：**${globalErrorRate}%**\n` +
                    `总请求数：${totalRequests}\n` +
                    `失败次数：${totalErrors}\n` +
                    `告警级别：${errorAlert.message}\n\n` +
                    `时间：${new Date().toLocaleString('zh-CN')}\n` +
                    `[查看 Dashboard](https://api.170909.xyz/dashboard)`
            },
            at: { isAtAll: true }
          };
          
          if (webhookType === 'dingtalk') {
            // 钉钉机器人格式
            alertBody.msgtype = 'markdown';
            await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(alertBody)
            });
          } else if (webhookType === 'telegram') {
            // Telegram Bot API
            const telegramUrl = `${webhookUrl}/sendMessage`;
            await fetch(telegramUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: webhookUrl.split('/bot')[1]?.split('/')[0],
                text: `🚨 **Gemini 代理错误告警**\n\n` +
                      `当前错误率：*${globalErrorRate}%*\n` +
                      `总请求数：${totalRequests}\n` +
                      `失败次数：${totalErrors}\n` +
                      `告警级别：${errorAlert.message}\n\n` +
                      `时间：${new Date().toLocaleString('zh-CN')}`,
                parse_mode: 'Markdown'
              })
            });
          }
        } catch (e) {
          console.error('Webhook 通知失败:', e);
        }
        
        // 更新上次告警级别
        await redis.set(lastAlertKey, errorAlert.level, { ex: 86400 }); // 24 小时过期
      }
    }

    return Response.json({
      globalRequests: parseInt(globalUsed),
      globalErrorRate,
      errorAlert,
      unknownModelAlert,
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
