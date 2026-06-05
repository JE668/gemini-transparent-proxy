# Gemini Transparent Proxy

基于 Next.js (App Router) 构建的 Gemini API 透明代理网关，兼容 OpenAI API 格式，支持流式响应、智能重试、实时遥测和 Dashboard 监控控制台。一键部署到 Vercel，零运维。

## ✨ 特性

- **透明代理** — 兼容 OpenAI `/v1/chat/completions` 和 `/v1/models` 格式，无需修改客户端代码
- **智能重试** — 上游 5xx 错误自动指数退避重试（最多 3 次），4xx 直接透传
- **流式支持** — SSE 流式响应完整转发，客户端断线自动中止上游读取
- **遥测统计** — 基于 Upstash Redis 的实时请求计数、延迟追踪、错误率统计
- **7 面板监控** — Dashboard 控制台：模型配额、时间线、来源分布、错误分析、最近请求、HTTP 状态码、重试统计
- **安全防护** — Dashboard 密码认证、API 限流（10 RPM/fingerprint）、CORS 白名单、生产环境错误脱敏
- **移动端适配** — 响应式布局，手机/平板/桌面均可正常使用
- **零外部依赖** — Dashboard 页面纯 CSS + SVG，无第三方 UI 库

## 🚀 快速部署

### 1. Fork 或 Clone 本仓库

### 2. 在 Vercel 导入项目

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/JE668/gemini-transparent-proxy)

### 3. 配置环境变量

在 Vercel 项目 Settings → Environment Variables 中添加：

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `GOOGLE_API_KEY` | ✅ | Google AI Studio 的 API Key |
| `UPSTASH_REDIS_REST_URL` | ✅ | Upstash Redis REST URL（免费额度足够） |
| `UPSTASH_REDIS_REST_TOKEN` | ✅ | Upstash Redis REST Token |
| `DASHBOARD_PASSWORD` | ❌ | Dashboard 访问密码，不设置则无需认证 |
| `CORS_ALLOWED_ORIGINS` | ❌ | CORS 允许的来源域名，逗号分隔，不设置则允许所有 |

### 4. 获取 Upstash Redis（免费）

1. 注册 [Upstash](https://upstash.com/)
2. 创建一个 Redis 数据库，选择免费套餐
3. 在数据库详情页复制 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`

## 📖 使用方法

### OpenAI 兼容格式

将任何 OpenAI 客户端的 `base_url` 替换为你的代理地址即可：

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-google-api-key",  # 原始 Google API Key
    base_url="https://your-domain.vercel.app/v1"
)

response = client.chat.completions.create(
    model="gemma-3-27b-it",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

### curl 调用

```bash
curl https://your-domain.vercel.app/v1/chat/completions \
  -H "Authorization: Bearer your-google-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemma-3-27b-it",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Gemini 原生 API 格式

也支持直接代理 Gemini 原生 API 路径：

```bash
curl "https://your-domain.vercel.app/api/v1beta/models/gemma-3-27b-it:generateContent?key=your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Hello!"}]}]}'
```

### 路由映射规则

| 客户端请求路径 | 代理到 Google API |
|----------------|-------------------|
| `/v1/chat/completions` | `/v1beta/openai/chat/completions` |
| `/v1/models` | `/v1beta/openai/models` |
| `/api/v1/*` | `/v1beta/openai/*` |
| `/api/*` | `/*`（原生 Gemini API） |

## 📊 Dashboard 控制台

访问 `/dashboard` 打开监控控制台，包含 7 个监控面板：

| 面板 | 说明 |
|------|------|
| **全局状态栏** | 系统状态、总请求数、平均延迟、错误率、重试次数、配额倒计时、Gemini/Redis 健康 |
| **模型配额** | 各模型已用/限额进度条、平均延迟、错误率 |
| **请求时间线** | 24 小时请求量折线图（鼠标悬停显示详情） |
| **来源分布** | API Key SHA-1 指纹（8 位）+ 请求次数 |
| **错误日志** | 最近 50 条错误，4xx/5xx 分色标注 + 中文解释 |
| **最近请求** | 实时请求流，含模型、状态码、延迟、重试次数 |
| **HTTP 状态码速查** | 所有出现过的状态码及中文含义 |

> 如设置了 `DASHBOARD_PASSWORD`，首次访问需输入密码。密码存储在浏览器 localStorage 中，刷新无需重新输入。

## 🔒 安全机制

| 机制 | 说明 |
|------|------|
| **Dashboard 认证** | 密码 + Bearer Token，密码存 localStorage，API 401 自动退回登录 |
| **API 限流** | 基于 API Key SHA-1 指纹的 60s 滑动窗口，默认 10 RPM |
| **CORS 控制** | `CORS_ALLOWED_ORIGINS` 白名单，未配置时允许 `*` |
| **错误脱敏** | 生产环境不暴露内部错误细节，返回通用中文提示 |
| **Health 认证** | `/api/health` 同样受 `DASHBOARD_PASSWORD` 保护 |
| **来源指纹** | 统计使用 SHA-1 前 8 位，不存储原始 API Key |

## 🏗️ 项目结构

```
├── app/
│   ├── api/
│   │   ├── [[...path]]/route.js  # 代理核心：路由映射、智能重试、遥测写入
│   │   ├── quota/route.js        # 配额统计 API（pipeline 批量获取）
│   │   ├── health/route.js       # 健康检查（Gemini API + Redis ping）
│   │   ├── errors/route.js       # 最近错误列表
│   │   ├── recent/route.js       # 最近请求流
│   │   ├── timeline/route.js     # 24h 请求时间线
│   │   ├── clients/route.js      # 来源分布统计
│   │   └── config/route.js       # 运行配置信息
│   └── dashboard/
│       └── page.js               # Dashboard 控制台页面（纯 CSS/SVG）
├── lib/
│   ├── models.js                 # 模型列表 + 配额定义
│   ├── redis.js                  # Redis 单例（Upstash）
│   └── utils.js                  # 配额日期计算
├── middleware.js                  # API Bearer Token 认证拦截
├── next.config.js                # Next.js 配置 + CORS
└── package.json
```

## 🔧 本地开发

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env.local
# 编辑 .env.local 填入你的密钥

# 启动开发服务器
npm run dev
```

`.env.local` 示例：

```env
GOOGLE_API_KEY=your-google-api-key
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-redis-token
DASHBOARD_PASSWORD=your-dashboard-password
CORS_ALLOWED_ORIGINS=https://your-frontend.com
```

## 📋 支持的模型

| 模型 | 日配额 | RPM | 上下文 |
|------|--------|-----|--------|
| `gemma-3-27b-it` | 14,400 | 30 | 128K |
| `gemma-4-31b-it` | 1,500 | 15 | 256K |
| `gemma-4-26b-a4b-it` | 1,500 | 15 | 256K |

> 以上为 Google AI Studio 免费层级配额，代理会自动选择高配额模型优先响应。

## 🛡️ API 端点

| 端点 | 认证 | 说明 |
|------|------|------|
| `/v1/*` | Google API Key | OpenAI 兼容代理 |
| `/api/v1/*` | Google API Key | OpenAI 兼容代理（备用路径） |
| `/api/*` | Google API Key | Gemini 原生 API 代理 |
| `/api/health` | `DASHBOARD_PASSWORD` | Gemini + Redis 健康检查 |
| `/api/quota` | `DASHBOARD_PASSWORD` | 配额使用统计 |
| `/api/timeline` | `DASHBOARD_PASSWORD` | 请求时间线数据 |
| `/api/errors` | `DASHBOARD_PASSWORD` | 错误日志 |
| `/api/recent` | `DASHBOARD_PASSWORD` | 最近请求 |
| `/api/clients` | `DASHBOARD_PASSWORD` | 来源分布 |
| `/api/config` | `DASHBOARD_PASSWORD` | 运行配置 |
| `/dashboard` | `DASHBOARD_PASSWORD` | 监控控制台 |

## 📝 License

MIT
