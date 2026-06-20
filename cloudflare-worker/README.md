# Cloudflare Workers Gemini Proxy

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
| 超时 | 60s (Hobby) | 无超时 |
| 遥测/Redis | ✅ | ❌（暂不支持） |
| Dashboard | ✅ | ❌ |
| 流式响应 | ✅ | ✅ |

## 测试

```bash
curl https://gemini-proxy.你的子域名.workers.dev/v1/models

curl https://gemini-proxy.你的子域名.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的-Google-API-Key" \
  -d '{"model":"gemma-4-31b-it","messages":[{"role":"user","content":"Hi"}],"max_tokens":50}'
```
