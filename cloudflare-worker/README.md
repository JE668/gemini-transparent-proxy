# Cloudflare Workers Gemini Proxy

> ⭐ **本项目的主力部署平台**：无函数超时限制、流式稳定、免费额度充足。Vercel 版近年在该项目上几乎不可用（Hobby 60s 超时 + 限流严格），仅作备选。日常使用请以本 Worker 为准。

## 部署

```bash
# 1. 安装 wrangler
npm install -g wrangler

# 2. 登录 Cloudflare
wrangler login

# 3. 部署
cd cloudflare-worker && wrangler deploy
```

部署成功后你会得到类似 `https://gemini-proxy.你的子域名.workers.dev` 的地址。

## 配置 QClaw

在 `~/.qclaw/openclaw.json` 中新增一个 provider：

```json
{
  "models": {
    "providers": {
      "custom-gemini-cf": {
        "baseUrl": "https://gemini-proxy.你的子域名.workers.dev",
        "apiKey": "你的-Google-API-Key",
        "api": "openai-completions",
        "models": [{ "id": "gemma-4-31b-it", "name": "gemma-4-31b-it" }]
      }
    }
  }
}
```

## 配置 Hermes

修改 `~/.hermes/config.yaml`：

```yaml
model:
  default: gemma-4-31b-it
  provider: custom:gemma-proxy-cf
```

在 auth.json 中添加认证。

## 与 Vercel 版差异

| 特性 | Vercel | CF Workers |
|------|--------|------------|
| 超时 | 60s (Hobby)，长请求易中断 | 无超时 |
| 遥测/Redis | ✅ | ✅（Upstash REST 写入，与 Vercel 端共用同一套 key，数据打通） |
| Dashboard | ✅ | 遥测共用（由 Next.js 端 `/dashboard` 展示 CF 流量数据） |
| 流式响应 | ✅ | ✅ |
| 目前状态 | ⚠️ 几乎不可用，仅容灾备选 | ⭐ 主力平台 |

> 注：CF Worker 通过 `ctx.waitUntil` 异步写 Upstash（status / timeline / quota / recent / errors / tpm / retries / slow 全量 key），字段与 Vercel 端一致，Dashboard 无需区分流量来源即可看到 CF 侧统计。

## 测试

```bash
curl https://gemini-proxy.你的子域名.workers.dev/v1/models

curl https://gemini-proxy.你的子域名.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的-Google-API-Key" \
  -d '{"model":"gemma-4-31b-it","messages":[{"role":"user","content":"Hi"}],"max_tokens":50}'
```
