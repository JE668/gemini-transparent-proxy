# Gemini 透明代理 - Dashboard 功能更新

## 📅 2026-06-07 更新

本次更新为 Dashboard 添加了三大核心优化功能，提升监控能力和告警响应速度。

---

## ✨ 新增功能

### 1. 配额耗尽预测 ⏱️

**功能描述**
- 基于当前使用速率预测每个模型的配额何时耗尽
- 自动计算从今天 00:00 到现在的平均使用速率
- 智能格式化显示（"2 小时 30 分"、"1.5 天"）

**告警级别**
- 🟢 **绿色**：预计 >4 小时耗尽（配额充足）
- 🟠 **橙色**：预计 <4 小时耗尽（需关注）
- 🔴 **红色**：预计 <2 小时耗尽（紧急）

**显示位置**
- 每个模型卡片内，配额进度条下方
- 仅显示未耗尽的模型预测

**技术实现**
```javascript
// 预测算法
const predictQuotaExhaustion = (used, limit, hoursElapsed) => {
  const hourlyRate = used / hoursElapsed;
  const remaining = limit - used;
  const hoursUntilExhaustion = remaining / hourlyRate;
  return {
    exhausted: false,
    minutes: hoursUntilExhaustion * 60,
    rate: hourlyRate,
    remaining,
  };
};
```

---

### 2. 分级错误告警 🚨

**功能描述**
- 实时监控全局错误率
- 根据错误率自动判断告警级别
- 在 Dashboard 显示醒目的告警框

**告警级别**
- 🚨 **严重**（错误率 >10%）：红色告警框
- ⚠️ **警告**（错误率 >5%）：橙色告警框
- ✅ **正常**（错误率 <5%）：不显示告警

**显示内容**
- 告警图标 + 级别消息
- 详细统计：总请求数、失败次数

**技术实现**
```javascript
// quota API 返回
{
  errorAlert: {
    level: 'critical' | 'warning' | 'normal',
    rate: 5.33,
    totalRequests: 150,
    totalErrors: 8,
    message: '警告：错误率超过 5%'
  }
}
```

---

### 3. Webhook 告警通知 📬

**功能描述**
- 当错误率从正常升级为警告/严重时，自动发送通知
- 使用 Redis 记录告警状态，24 小时内不重复通知
- 支持钉钉和 Telegram 两种机器人

**支持平台**
- **钉钉机器人**：Markdown 格式消息
- **Telegram Bot**：Markdown 格式消息

**触发条件**
- 错误率从 normal → warning（升级告警）
- 错误率从 normal/warning → critical（严重告警）
- 每天每个级别只通知一次（避免骚扰）

**消息内容**
```
🚨 Gemini 代理错误告警

**错误率告警**

当前错误率：5.33%
总请求数：150
失败次数：8
告警级别：警告：错误率超过 5%

时间：2026-06-07 18:30:00
[查看 Dashboard](https://api.170909.xyz/dashboard)
```

**环境配置**
```bash
# 钉钉机器人
ERROR_WEBHOOK_URL=https://oapi.dingtalk.com/robot/send?access_token=xxx
ERROR_WEBHOOK_TYPE=dingtalk

# Telegram Bot
ERROR_WEBHOOK_URL=https://api.telegram.org/bot<token>
ERROR_WEBHOOK_TYPE=telegram
```

**技术实现**
```javascript
// Redis 记录告警状态
const lastAlertKey = `alert:last_error_level:${new Date().toDateString()}`;
const lastLevel = await redis.get(lastAlertKey);

// 只有级别升级时才发送
const levelPriority = { normal: 0, warning: 1, critical: 2 };
const shouldNotify = levelPriority[current] > levelPriority[last];
```

---

## 📊 Dashboard 完整功能清单

| 类别 | 功能 | 状态 |
|------|------|------|
| **配额监控** | 实时配额使用量 | ✅ |
| | 配额重置倒计时 | ✅ |
| | 配额耗尽预测 | ✅ **NEW** |
| | 配额告警（>90%） | ✅ |
| **错误监控** | 全局错误率 | ✅ |
| | 分级错误告警 | ✅ **NEW** |
| | Webhook 通知 | ✅ **NEW** |
| | 实时错误日志 | ✅ |
| **性能监控** | 平均延迟 | ✅ |
| | 重试次数追踪 | ✅ |
| **流量分析** | 请求时间线（24h） | ✅ |
| | 模型路由分布 | ✅ |
| | 来源统计（Top10） | ✅ |
| **系统健康** | Gemini API 状态 | ✅ |
| | Redis 连接状态 | ✅ |
| **数据导出** | CSV 导出 | ✅ |
| **用户体验** | 暗黑模式 | ✅ |
| | 响应式设计 | ✅ |
| | 认证保护 | ✅ |

---

## 🔧 部署配置

### Vercel 环境变量

在 Vercel 项目设置中添加以下环境变量：

```bash
# 必需
GOOGLE_API_KEY=xxx
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxx

# 可选
DASHBOARD_PASSWORD=your-password
ERROR_WEBHOOK_URL=https://oapi.dingtalk.com/robot/send?access_token=xxx
ERROR_WEBHOOK_TYPE=dingtalk
```

### 本地开发

```bash
cp .env.example .env.local
# 编辑 .env.local 填入实际值
npm run dev
```

---

## 📈 监控建议

### 日常巡检
1. 打开 Dashboard 查看配额预测（绿色为正常）
2. 检查是否有错误告警框（无告警为正常）
3. 关注重试次数趋势

### 告警响应
- 收到 **警告** 通知：检查 API 日志，确认是否有临时故障
- 收到 **严重** 通知：立即可查，可能需要紧急修复
- 配额预测 **红色**：考虑调整路由策略或申请增加配额

### 最佳实践
1. 配置钉钉/Telegram 告警，确保第一时间获知问题
2. 每天早晚各查看一次 Dashboard
3. 配额使用超过 70% 时关注预测趋势
4. 错误率连续 3 次 >5% 时启动排查流程

---

## 🛠️ 技术栈

- **前端**: Next.js 16 + React 18
- **后端**: Next.js API Routes (Edge Runtime)
- **数据库**: Upstash Redis (Serverless)
- **部署**: Vercel
- **监控**: 自定义 Dashboard + Webhook 告警

---

## 📝 更新日志

### 2026-06-07
- ✅ 新增配额耗尽预测功能
- ✅ 新增分级错误告警显示
- ✅ 新增 Webhook 告警通知（钉钉/Telegram）
- ✅ 优化错误率计算逻辑
- ✅ 更新 .env.example 配置模板

### 之前版本
- ✅ 请求时间线图表
- ✅ 模型路由分布
- ✅ 来源统计
- ✅ 重试事件追踪
- ✅ 实时错误日志
- ✅ CSV 导出
- ✅ 暗黑模式
- ✅ 响应式设计

---

## 📞 支持与反馈

如有问题或建议，请通过以下方式联系：
- GitHub Issues: https://github.com/JE668/gemini-transparent-proxy/issues
- Dashboard: https://api.170909.xyz/dashboard