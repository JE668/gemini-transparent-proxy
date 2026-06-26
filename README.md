# Gemini Transparent Proxy

> 将 Google Gemini / Gemma 模型包装为 OpenAI 兼容 API，支持 Chat Completions 和 Responses API 双协议，让 QClaw、Workbuddy、OpenClaw、Hermes Agent、Codex 等客户端无缝接入。

基于 Next.js (App Router) + Cloudflare Workers 双平台部署，零运维。流式 SSE、智能重试、模型降级、`<thought>` 思考过程提取、实时遥测 Dashboard 一应俱全。

---

## 📐 架构概览

```
                          ┌─────────────────────────────────────────────┐
                          │           gemini-transparent-proxy           │
                          │                                             │
  QClaw / Workbuddy ─────▶│  /v1/chat/completions  (Chat Completions)   │
  OpenClaw / Hermes  ────▶│  /v1/chat/completions  (Chat Completions)   │──▶ Google AI
  Codex (CLI/App)    ────▶│  /v1/responses         (Responses API)     │    generativelanguage
  curl / SDK         ────▶│  /v1/models            (模型列表)            │    .googleapis.com
                          │  /api/*                (Gemini 原生 API)     │
                          └─────────────────────────────────────────────┘
                                     │
                          ┌──────────┴──────────┐
                          │   Upstash Redis      │  遥测 + Session 存储
                          │   (免费额度即可)      │
                          └─────────────────────┘
```

---

## 🧩 客户端兼容性矩阵

| 客户端 | 端点 | `base_url` 配置 | SSE 流式 | 思考过程 | 备注 |
|--------|------|-----------------|----------|----------|------|
| **QClaw** | `/v1/chat/completions` | `https://your-domain/v1` | ✅ | ✅ `reasoning_content` | QClaw 兼容模式：非流式转发后手动拆分为 SSE，先发 reasoning 再发 content |
| **Workbuddy** | `/v1/chat/completions` | `https://your-domain/v1` | ✅ | ✅ `reasoning_content` | 同 QClaw，兼容路径自动激活 |
| **OpenClaw** | `/v1/chat/completions` | `https://your-domain/v1` | ✅ | ✅ `reasoning_content` | 标准 OpenAI 兼容协议 |
| **Hermes Agent** | `/v1/chat/completions` | `https://your-domain/v1` | ✅ | ✅ `reasoning_content` | 标准 OpenAI 兼容协议 |
| **Codex (CLI/App)** | `/v1/responses` | `https://your-domain/v1` | ✅ | ✅ `reasoning_summary_text` | `wire_api = "responses"`，支持 `previous_response_id` 会话重建 |
| **OpenAI SDK** | `/v1/chat/completions` | `https://your-domain/v1` | ✅ | ✅ `reasoning_content` | Python / Node SDK 均可 |
| **curl** | 全部端点 | — | ✅ | ✅ | 手动调用 |
| **Gemini SDK** | `/api/*` | `https://your-domain/api` | ✅ | N/A | 原生 Gemini API 透传 |

### 思考过程提取

Gemma 4 模型在输出中通过 `<thought>...</thought>` 标签表达推理过程。代理通过跨 SSE 事件的状态机缓冲，实时提取标签内容并转换为标准格式：

| 协议 | 思考内容字段 | 说明 |
|------|-------------|------|
| Chat Completions | `delta.reasoning_content` | 兼容 DeepSeek / QClaw / Workbuddy |
| Responses API | `response.reasoning_summary_text.delta` | 兼容 Codex 原生 reasoning 事件 |

---

## 🚀 快速部署

### 方式一：Vercel（推荐主力）

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/JE668/gemini-transparent-proxy)

1. Fork 本仓库
2. 在 Vercel 导入项目
3. 配置环境变量（见下表）
4. 自动部署完成

### 方式二：Cloudflare Workers（容灾 / 备用）

通过 GitHub Actions 自动部署：

1. Fork 本仓库
2. 在仓库 Settings → Secrets 添加：
   - `CLOUDFLARE_API_TOKEN` — Cloudflare API Token
   - `CLOUDFLARE_ACCOUNT_ID` — Account ID
3. 在 Cloudflare 创建 Worker，绑定自定义域名
4. Push 到 `main` 分支即自动部署（`.github/workflows/deploy.yml`）
5. 在 Worker Settings → Variables 配置环境变量

> ⚠️ **不要使用 Cloudflare Workers Builds 的 Git 集成**。本项目使用 GitHub Actions 部署，Workers Builds 的 root directory 默认指向仓库根目录（找不到 `wrangler.toml`），需手动断开 GitHub 连接避免每次 push 报错。

### 环境变量

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `GOOGLE_API_KEY` | ✅ | Google AI Studio 的 API Key |
| `UPSTASH_REDIS_REST_URL` | ✅ | Upstash Redis REST URL（免费额度足够） |
| `UPSTASH_REDIS_REST_TOKEN` | ✅ | Upstash Redis REST Token |
| `DASHBOARD_PASSWORD` | ❌ | Dashboard 访问密码，不设置则无需认证 |
| `CORS_ALLOWED_ORIGINS` | ❌ | CORS 允许的来源域名，逗号分隔 |

---

## 🛠️ 客户端配置指南

### QClaw / Workbuddy

```
API Base URL: https://your-domain/v1
API Key:      你的 Google API Key
Model:        gemma-4-31b-it
```

**自动兼容**：代理检测到 QClaw/Workbuddy 的 User-Agent 后，会自动将流式请求改为非流式发给 Google，收到完整 JSON 后手动拆分为 SSE chunks（先 reasoning_content 后 content），确保思考框正确显示。

### OpenClaw / Hermes Agent

```
API Base URL: https://your-domain/v1
API Key:      你的 Google API Key
Model:        gemma-4-31b-it
```

标准 OpenAI 兼容协议，直接使用流式 SSE。`<thought>` 标签通过跨事件状态机实时提取为 `delta.reasoning_content`。

### Codex (CLI / App)

Codex 使用 Responses API（`/v1/responses`），需要在配置文件中指定 `wire_api = "responses"`。

**`~/.codex/config.toml`**：
```toml
model_provider = "gemini-proxy"
model = "gemma-4-31b-it"
model_reasoning_effort = "high"
disable_response_storage = true
sandbox_mode = "workspace-write"

[model_providers.gemini-proxy]
name = "Gemini Proxy"
base_url = "https://your-domain/v1"
wire_api = "responses"
requires_openai_auth = true
```

**`~/.codex/auth.json`**：
```json
{
  "OPENAI_API_KEY": "你的 Google API Key"
}
```

**功能支持**：
- ✅ 流式 SSE（`response.created` → `reasoning_summary_text.delta` → `output_text.delta` → `response.completed`）
- ✅ 思考过程提取（`<thought>` → 独立 reasoning output item）
- ✅ 会话重建（`previous_response_id`，基于 Redis 持久化）
- ✅ Tool calling（自动清洗字段以兼容 Google API）
- ✅ 模型降级（`gemma-4-31b-it` → `gemma-4-26b-a4b-it` → `gemini-2.5-flash`）

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-google-api-key",
    base_url="https://your-domain/v1"
)

response = client.chat.completions.create(
    model="gemma-4-31b-it",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)
```

### curl

```bash
# Chat Completions
curl https://your-domain/v1/chat/completions \
  -H "Authorization: Bearer your-google-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma-4-31b-it","messages":[{"role":"user","content":"Hello!"}],"stream":true}'

# Responses API (Codex 兼容)
curl https://your-domain/v1/responses \
  -H "Authorization: Bearer your-google-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma-4-31b-it","input":"Hello!","stream":true}'
```

---

## ✨ 核心特性

### 智能重试 & 模型降级

| 机制 | 说明 |
|------|------|
| **指数退避重试** | 上游 5xx 错误自动重试（最多 3 次），4xx 直接透传 |
| **模型降级链** | `gemma-4-31b-it` → `gemma-4-26b-a4b-it` → `gemini-2.5-flash` |
| **QClaw 兼容模式** | 非流式转发后手动拆分为 SSE，先发 reasoning 再发 content |
| **`<thought>` 状态机** | 跨 SSE 事件缓冲，实时提取思考标签为 `reasoning_content` / `reasoning_summary_text` |
| **Tools 字段清洗** | 自动剥离 Google API 不认的多余字段（如 `type`） |

### Responses API（Codex 兼容）

代理在 `/v1/responses` 端点实现了 Responses API ↔ Chat Completions API 双向转换：

- **请求转换**：Responses API input items → Chat messages，tools 转换，`reasoning.effort` 映射
- **流式响应**：Chat SSE chunks → 7+ 种 Responses API SSE 事件
- **会话持久化**：`previous_response_id` 基于 Redis 存储，支持跨会话恢复
- **完整事件序列**：`response.created` → `output_item.added` → `reasoning_summary_text.delta` → `output_text.delta` → `response.completed`

### 遥测 & 监控

- **Upstash Redis** 实时请求计数、延迟追踪、错误率统计
- **7 面板 Dashboard**：模型配额、请求时间线、来源分布、错误日志、最近请求、HTTP 状态码、重试统计
- **移动端适配**：响应式布局，手机/平板/桌面均可使用
- **安全防护**：Dashboard 密码认证、API 限流（10 RPM/fingerprint）、CORS 白名单、生产环境错误脱敏

---

## 📊 Dashboard 控制台

访问 `/dashboard` 打开监控控制台：

| 面板 | 说明 |
|------|------|
| **全局状态栏** | 系统状态、总请求数、平均延迟、错误率、重试次数、配额倒计时 |
| **模型配额** | 各模型已用/限额进度条、平均延迟、错误率 |
| **请求时间线** | 24 小时请求量折线图（鼠标悬停显示详情） |
| **来源分布** | API Key SHA-1 指纹（8 位）+ 请求次数 |
| **错误日志** | 最近 50 条错误，4xx/5xx 分色标注 + 中文解释 |
| **最近请求** | 实时请求流，含模型、状态码、延迟、重试次数 |
| **HTTP 状态码** | 所有出现过的状态码及中文含义 |

---

## 📋 支持的模型

| 模型 | 日配额 | RPM | 上下文 | 说明 |
|------|--------|-----|--------|------|
| `gemma-4-31b-it` | 1,500 | 15 | 256K | ⭐ 主力模型（Dense） |
| `gemma-4-26b-a4b-it` | 1,500 | 15 | 256K | MoE 备选 |

> 配额为 Google AI Studio 免费层级限制。代理在主力模型配额耗尽时自动降级。

---

## 🛡️ API 端点一览

| 端点 | 认证 | 协议 | 说明 |
|------|------|------|------|
| `/v1/chat/completions` | Google API Key | Chat Completions | OpenAI 兼容（QClaw / Workbuddy / OpenClaw / Hermes） |
| `/v1/responses` | Google API Key | Responses API | Codex 兼容（会话重建 + reasoning events） |
| `/v1/models` | Google API Key | — | 模型列表 |
| `/api/v1/*` | Google API Key | Chat Completions | 备用路径 |
| `/api/*` | Google API Key | Gemini 原生 | Gemini API 透传 |
| `/api/health` | Dashboard 密码 | — | Gemini + Redis 健康检查 |
| `/api/quota` | Dashboard 密码 | — | 配额使用统计 |
| `/api/timeline` | Dashboard 密码 | — | 请求时间线数据 |
| `/api/errors` | Dashboard 密码 | — | 错误日志 |
| `/api/recent` | Dashboard 密码 | — | 最近请求 |
| `/api/clients` | Dashboard 密码 | — | 来源分布 |
| `/api/config` | Dashboard 密码 | — | 运行配置 |
| `/dashboard` | Dashboard 密码 | — | 监控控制台 |

### 路由映射

| 客户端请求路径 | 代理到 Google API |
|----------------|-------------------|
| `/v1/chat/completions` | `/v1beta/openai/chat/completions` |
| `/v1/responses` | 转换后请求 `/v1beta/openai/chat/completions` |
| `/v1/models` | `/v1beta/openai/models` |
| `/api/v1/*` | `/v1beta/openai/*` |
| `/api/*` | `/*`（原生 Gemini API） |

---

## 🏗️ 项目结构

```
├── app/
│   ├── api/
│   │   ├── [[...path]]/route.js     # 代理核心：路由映射、智能重试、遥测、QClaw 兼容
│   │   ├── responses/route.js       # Responses API 入口（Vercel）
│   │   ├── quota/route.js           # 配额统计
│   │   ├── health/route.js          # 健康检查
│   │   ├── errors/route.js          # 错误日志
│   │   ├── recent/route.js          # 最近请求
│   │   ├── timeline/route.js        # 24h 时间线
│   │   ├── clients/route.js         # 来源分布
│   │   └── config/route.js          # 运行配置
│   └── dashboard/
│       └── page.js                  # Dashboard 控制台（纯 CSS/SVG）
├── lib/
│   ├── models.js                    # 模型列表 + 配额定义
│   ├── redis.js                     # Redis 单例（Upstash）
│   ├── utils.js                     # 配额日期计算
│   ├── responses.js                 # Responses API ↔ Chat 转换层
│   └── responses-handler.js         # Responses API Vercel 入口
├── cloudflare-worker/
│   ├── src/
│   │   ├── index.js                 # CF Worker 代理核心
│   │   └── responses.js             # CF Worker Responses API
│   ├── wrangler.toml                # CF Worker 配置
│   └── package.json
├── .github/
│   └── workflows/
│       └── deploy.yml               # CF Worker 自动部署
├── middleware.js                    # Dashboard API Bearer Token 认证
├── next.config.js                   # Next.js 配置 + CORS
└── package.json
```

---

## 🔧 本地开发

```bash
npm install
cp .env.example .env.local
# 编辑 .env.local 填入密钥
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

---

## 🔒 安全机制

| 机制 | 说明 |
|------|------|
| **Dashboard 认证** | 密码 + Bearer Token，API 401 自动退回登录 |
| **API 限流** | 基于 API Key SHA-1 指纹的 60s 滑动窗口，默认 10 RPM |
| **CF Worker 限流** | 基于 IP 的内存滑动窗口，60 RPM |
| **CORS 控制** | `CORS_ALLOWED_ORIGINS` 白名单，未配置时允许 `*` |
| **错误脱敏** | 生产环境不暴露内部错误细节 |
| **来源指纹** | 统计使用 SHA-1 前 8 位，不存储原始 API Key |

---

## 📝 License

MIT
