# Codex 配置 gemma-4 通过 gemini-transparent-proxy

## 目标

配置 Codex 客户端通过 gemini-transparent-proxy 使用 Google gemma-4-31b-it 模型。

## 配置变更

### ~/.codex/config.toml
- `model_provider` → `"gemini-proxy"`
- `model` → `"gemma-4-31b-it"`
- `base_url` → `"https://api.gemmaproxy.dpdns.org/v1"`
- `wire_api` → `"responses"` (Responses API)
- `requires_openai_auth` → `true`

### ~/.codex/auth.json
- `OPENAI_API_KEY` → 用户的 Google API Key

## 修复：流式 `<thought>` 标签提取

发现并修复了流式 Responses API 中 `<thought>` 标签未实时提取的问题：
- **问题**: `streamResponses()` 直接连 Google API，`<thought>` 标签在 `delta.content` 中但只在流结束后才提取，导致标签泄漏到 `output_text.delta` 事件
- **修复**: 在 `lib/responses.js` 和 `cloudflare-worker/src/responses.js` 中加入跨 chunk 的 `<thought>` 状态机（`inThought` + `contentBuffer`），实时提取标签为 `reasoning_summary_text.delta` 事件
- commit: c0806df

## 验证结果

- 非流式 `/v1/responses` ✅ — 返回 reasoning + message output items
- 流式 `/v1/responses` ✅ — 完整事件序列: response.created → reasoning → message → response.completed
- `/v1/models` ✅ — 返回 gemma-4-31b-it 和 gemma-4-26b-a4b-it
- `<thought>` 标签实时提取 ✅ — 不再泄漏到 output_text

## 事件序列（流式）

```
response.created
→ response.output_item.added (reasoning)
→ response.reasoning_summary_part.added
→ response.reasoning_summary_text.delta (×N)
→ response.reasoning_summary_text.done
→ response.reasoning_summary_part.done
→ response.output_item.done (reasoning)
→ response.output_item.added (message)
→ response.output_text.delta (×N)
→ response.output_item.done (message)
→ response.completed
```
