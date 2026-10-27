// lib/token-limit.js
//
// 代理侧「token 感知限流」所需的共享数据：
//   1. TPM_LIMITS  —— 各模型免费层「每分钟输入 token」上限。
//   2. estimateInputTokens —— 启发式估算一次请求的输入 token 数。
//
// 数据来源：generativelanguage.googleapis.com 控制台「速率限制（按模型）」配额导出
//           （2026-10-25 快照：Gemma 4 = 16K、Flash = 250K、TTS = 10K、Antigravity = 100K；
//            新增 Gemini 3.8 系列，移除已在速率表消失的 gemini-3.5-flash）。
// 用途：在代理侧提前拦住会撞 Google 免费层 16K TPM 墙的请求，避免收到 429。
//
// ⚠️ 本模块是两端共用的唯一来源：cloudflare-worker/src/index.js 已改为 `import` 本文件，
//    由 wrangler/esbuild 打包进 Worker 产物。tests/sync.test.mjs 会断言 CF Worker 不再内联副本。

// 各模型每分钟输入 token 上限（Infinity / 缺失 = 不限制）
export const TPM_LIMITS = {
  // Gemma 4 系列：免费层仅 16K/分钟（根因）
  'gemma-4-31b-it': 16000,
  'gemma-4-26b-a4b-it': 16000,

  // Flash 系列：250K/分钟，适合做主力/降级目标
  'gemini-3.8-flash': 250000,
  'gemini-3.5-flash-lite': 250000,
  'gemini-3.1-flash-lite': 250000,
  'gemini-3.6-flash': 250000,
  'gemini-3-flash-preview': 250000,
  'gemini-2.5-flash': 250000,
  'gemini-2.5-flash-lite': 250000,

  // TTS：10K/分钟
  'gemini-3.8-flash-tts': 10000,
  'gemini-3.8-flash-lite-tts': 10000,
  'gemini-2.5-flash-preview-tts': 10000,
  'gemini-3.1-flash-tts-preview': 10000,

  // Agent 模型（走 Interactions API）：100K/分钟
  'antigravity-preview-05-2026': 100000,
};

// 启发式估算输入 token 数（保守向，略微高估以降低超额风险）。
// 规则：每条 message 固定开销 4 token + 文本按 ~4 字符/token 估算（英文偏准，中文略低估但整体偏保守）。
//
// 覆盖三种请求形态：
//   1. Chat Completions：顶层 system + messages[].content（字符串 / 多模态 parts）
//   2. Responses API：顶层 instructions + input（字符串 / 消息数组）
//   3. 工具调用负载：messages[].tool_calls[].function.arguments 与 input 中的
//      function_call / function_call_output —— Agent 场景下这部分往往比对话正文更大，
//      漏算会直接撞穿上游 TPM 墙。
export function estimateInputTokens(body) {
  if (!body || typeof body !== 'object') return 0;
  const texts = [];
  collectChatTexts(body, texts);
  collectResponsesTexts(body, texts);
  let total = 0;
  for (const t of texts) total += 4 + Math.ceil(t.length / 4);
  return total;
}

// Chat Completions：system（字符串或 parts 数组）+ messages
function collectChatTexts(body, texts) {
  if (typeof body.system === 'string') {
    texts.push(body.system);
  } else if (Array.isArray(body.system)) {
    for (const part of body.system) {
      if (part && typeof part.text === 'string') texts.push(part.text);
    }
  }
  if (!Array.isArray(body.messages)) return;
  for (const m of body.messages) {
    if (!m) continue;
    if (typeof m.content === 'string') {
      texts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && typeof part.text === 'string') texts.push(part.text);
      }
    }
    // 助手消息里的工具调用参数也是输入 token（Agent 场景占比很高）
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc && tc.function;
        if (!fn) continue;
        if (typeof fn.arguments === 'string') texts.push(fn.arguments);
        if (typeof fn.name === 'string') texts.push(fn.name);
      }
    }
  }
}

// Responses API：instructions + input（字符串或条目数组）
function collectResponsesTexts(body, texts) {
  if (typeof body.instructions === 'string') texts.push(body.instructions);
  if (typeof body.input === 'string') {
    texts.push(body.input);
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item) continue;
      if (typeof item === 'string') {
        texts.push(item);
        continue;
      }
      // message 条目：content 可能是字符串或 parts 数组
      if (typeof item.content === 'string') {
        texts.push(item.content);
      } else if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part && typeof part.text === 'string') texts.push(part.text);
        }
      }
      // 工具调用条目
      if (typeof item.arguments === 'string') texts.push(item.arguments);
      if (typeof item.name === 'string') texts.push(item.name);
      if (typeof item.output === 'string') texts.push(item.output);
    }
  }
}
