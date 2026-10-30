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
//
// ⚠️ 旧实现对所有文本一律 `ceil(len / 4)`，这对英文大致准确，
//    但对中文严重低估：Gemini 的 tokenizer 对中文大致是「1 个汉字 ≈ 0.6–1 token」，
//    而 4 字符/token 会把一段中文低估 3~4 倍 → 代理以为没超 TPM 墙，
//    上游直接回 429，用户看到的是「代理没拦住却失败」。
//
// 现在按字符类别分别估算：
//   · CJK 汉字 / 全角标点 / 日文假名 / 韩文音节 → 每字 1 token（保守高估）
//   · 其它字符（拉丁字母、数字、常见符号、空白）→ 每 4 字符 1 token
//   · Emoji / 其它 4 字节字符 → 每字 2 token（保守高估）
//
// 估算仍然「宁可略高不可略低」：偏大 → 代理提前 429（用户看到可重试提示 + Retry-After）；
// 偏小 → 撞穿上游配额墙（用户看到不可重试的失败）。后者明显更糟。
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
  for (const t of texts) total += 4 + estimateTextTokens(t);
  return total;
}

/**
 * 估算单段文本的 token 数（中英混合感知）。
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTextTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  let cjk = 0;      // CJK 类字符数
  let emoji = 0;    // 4 字节（星平面）字符数
  let other = 0;    // 其余字符数
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x10000) {
      // 星平面：绝大多数是 Emoji / 特殊符号，按 2 token 保守计
      emoji++;
    } else if (isCjkCodePoint(code)) {
      cjk++;
    } else {
      other++;
    }
  }
  // CJK 每字 1 token；Emoji 每字 2 token；其余每 4 字符 1 token（向上取整）
  return cjk + emoji * 2 + Math.ceil(other / 4);
}

/**
 * 判断一个码点是否属于「按 1 token/字」估算的 CJK 类字符。
 *
 * 覆盖范围（刻意保守，宁可多算）：
 *   · CJK 统一表意文字（含扩展 A / 兼容表意文字）
 *   · CJK 符号与标点（U+3000–U+303F）
 *   ·  Hiragana / Katakana（含半角片假名 U+FF66–U+FF9D）
 *   ·  Hangul 音节（U+AC00–U+D7A3）
 *   ·  CJK 扩展 B 及以上（U+20000–U+2FA1F）
 *   ·  全角形式（U+FF01–U+FF60 全角 ASCII/标点、U+FFE0–U+FFE6 全角货币符号）
 */
function isCjkCodePoint(code) {
  if (code >= 0x4e00 && code <= 0x9fff) return true;      // CJK Unified Ideographs
  if (code >= 0x3400 && code <= 0x4dbf) return true;      // CJK Ext A
  if (code >= 0xf900 && code <= 0xfaff) return true;      // CJK Compatibility Ideographs
  if (code >= 0x3000 && code <= 0x303f) return true;      // CJK Symbols and Punctuation
  if (code >= 0x3040 && code <= 0x309f) return true;      // Hiragana
  if (code >= 0x30a0 && code <= 0x30ff) return true;      // Katakana
  if (code >= 0xff66 && code <= 0xff9d) return true;      // Halfwidth Katakana
  if (code >= 0xac00 && code <= 0xd7a3) return true;      // Hangul Syllables
  if (code >= 0x20000 && code <= 0x2fa1f) return true;    // CJK Ext B..F
  if (code >= 0xff01 && code <= 0xff60) return true;      // Fullwidth ASCII（！＂＃…～）
  if (code >= 0xffe0 && code <= 0xffe6) return true;      // Fullwidth currency signs
  return false;
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
