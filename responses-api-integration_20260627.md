# Responses API 集成到 gemini-transparent-proxy

## 目标

将 codex-proxy 的 Responses API ↔ Chat Completions API 双向转换功能集成到 gemini-transparent-proxy 中，使 Codex、QClaw、Workbuddy 等 Responses API 客户端可以直接使用 Google Gemini 模型。

## 关键决策

采用**方案 A：合并入 gemini-transparent-proxy**（而非单独部署 codex-proxy 到 CF Workers），原因：
- gemini-transparent-proxy 已有完善的智能重试、模型降级、QClaw 兼容路径、`<thought>` 提取、Dashboard 监控
- codex-proxy 的核心价值（协议转换）可以作为独立模块嵌入

## 新增文件

### 1. `lib/responses.js` (Vercel 端核心模块)
- `responsesToChat()`: Responses API 请求 → Chat Completions 请求
- `chatToResponses()`: Chat 响应 → Responses API 响应（非流式）
- `streamResponses()`: async generator，Chat SSE → Responses API SSE 事件流
- SessionStore: 基于 Upstash Redis，支持 `previous_response_id` 历史重建
- 完整 SSE 事件序列: `response.created` → `reasoning_summary_text.delta` → `output_text.delta` → `response.completed`
- 支持 function_call output items
- `<thought>` 标签提取 → reasoning output item
- MD5 → SHA-1（CF Workers crypto.subtle 不支持 MD5）

### 2. `lib/responses-handler.js` (Vercel 端入口)
- 被 catch-all 路由 `app/api/[[...path]]/route.js` 调用
- 处理 `previous_response_id` 历史合并
- 将 `reasoning_content` 转回 `<thought>` 标签供 Google API 处理
- 流式/非流式分支

### 3. `cloudflare-worker/src/responses.js` (CF Worker 版)
- 从 `lib/responses.js` 移植，适配 CF Workers 运行时
- 使用 TransformStream 替代 async generator
- Redis 操作通过 REST API
- 独立完整的处理流程（不依赖外部模块）

## 修改文件

### `app/api/[[...path]]/route.js`
- 添加 import `handleResponsesApi`
- 在 models 检查之后插入 `/v1/responses` 路由拦截（POST + GET）

### `cloudflare-worker/src/index.js`
- 添加 import `handleResponses`
- 在 models 检查之后、限流之前插入 Responses API 路由

## 端点

- `POST /v1/responses` — Responses API（流式 + 非流式）
- 支持 `previous_response_id`（历史重建 via Redis）
- 支持 `instructions`/`system`、`input`（string/items）、`tools`、`reasoning_effort`
- 输出: reasoning output item（独立思考框）+ message output item + function_call items

## 兼容性

- **Codex**: 直接使用 Responses API
- **QClaw/Workbuddy**: 已有的 Chat Completions 路径不受影响
- **CF Worker**: 独立运行，不依赖 Vercel

## 验证

- 全部文件通过 `node --check` 语法检查
- `responsesToChat()` 转换正确（instructions→system, input_text→text, tools→function）
- `chatToResponses()` 转换正确（reasoning_content→reasoning item, content→message item）
- 已 commit (6827da8) 并 push 到 GitHub

## 后续

- Vercel 自动部署后需端到端测试
- CF Worker 需 `wrangler deploy` 部署
- 可考虑添加 `/v1/responses/:id` GET 端点（获取已存储的 response）
