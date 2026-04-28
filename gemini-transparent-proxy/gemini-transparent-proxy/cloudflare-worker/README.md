# Gemini Proxy - Cloudflare Workers 版本

## 为什么选择 Cloudflare Workers？

| 对比项 | Vercel | Cloudflare Workers |
|--------|--------|-------------------|
| 执行超时 | 10s (免费) / 50s (付费) | **无限制** |
| 流式响应 | 需要特殊处理 | **原生支持** |
| 冷启动 | 有 | **几乎无** |
| 地理位置 | 美国为主 | **香港/日本节点可选** |
| 免费额度 | 每天 100 次 serverless | **每天 100,000 次** |

## 部署步骤

### 前置要求
- 一个 Cloudflare 账号 ([注册地址](https://dash.cloudflare.com/))
- Node.js 18+ 环境

### 步骤 1: 安装 Wrangler CLI

```bash
npm install -g wrangler
```

### 步骤 2: 创建 Worker 项目

```bash
# 进入 cloudflare-worker 目录
cd cloudflare-worker

# 本地测试
wrangler dev

# 部署到生产环境
wrangler deploy
```

部署成功后会返回一个 `.workers.dev` 子域名，例如：
```
https://gemini-proxy.账号名.workers.dev
```

### 步骤 3: 配置自定义域名（可选）

如果你有自己的域名，可以在 Cloudflare Dashboard 中：
1. 进入 Workers & Pages
2. 选择你的 Worker
3. 点击 "Triggers" -> "Custom Domains"
4. 添加你的域名

### 步骤 4: 使用方式

将你原本请求 Google Gemini API 的地址从：

```
https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=你的API_KEY
```

改为你的 Worker 地址：

```
https://你的域名/v1/models/gemini-2.0-flash:generateContent?key=你的API_KEY
```

或者如果你使用的是 OpenAI 兼容格式：

```
# 原本
https://generativelanguage.googleapis.com/v1beta/openai/chat/completions?key=你的API_KEY

# 改为
https://你的域名/v1beta/openai/chat/completions?key=你的API_KEY
```

## 本地开发测试

```bash
cd cloudflare-worker
wrangler dev

# 然后发送测试请求
curl -X POST "http://localhost:8787/v1beta/models/gemini-2.0-flash:generateContent?key=测试KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Hello"}]}]}'
```

## 已知问题

无。

## 费用

Cloudflare Workers 免费额度：
- 每天 100,000 次请求
- CPU 执行时间每天 400,000 GB-秒

个人使用完全免费。