// lib/token-limit.js
//
// 代理侧「token 感知限流」所需的共享数据：
//   1. TPM_LIMITS  —— 各模型免费层「每分钟输入 token」上限。
//   2. estimateInputTokens —— 启发式估算一次请求的输入 token 数。
//
// 数据来源：Google Cloud Console「速率限制（按模型）」本月峰值/限额视图
//           （用户 2026-07-21 核对；Gemma 4 的 TPM 由 7/10 快照的「无限」收紧为 16K；
//            2026-07-22 用另一 API key 交叉核对一致：Gemma 4 = 16K、Flash = 250K）。
// 用途：在代理侧提前拦住会撞 Google 免费层 16K TPM 墙的请求，避免收到 429。
//
// ⚠️ 与 cloudflare-worker/src/index.js 内联的 TPM_LIMITS / estimateInputTokens 必须保持一致。

// 各模型每分钟输入 token 上限（Infinity / 缺失 = 不限制）
export const TPM_LIMITS = {
  // Gemma 4 系列：免费层仅 16K/分钟（根因）
  'gemma-4-31b-it': 16000,
  'gemma-4-26b-a4b-it': 16000,

  // Flash 系列：250K/分钟，适合做主力/降级目标
  'gemini-3.5-flash-lite': 250000,
  'gemini-3.1-flash-lite': 250000,
  'gemini-3.6-flash': 250000,
  'gemini-3.5-flash': 250000,
  'gemini-3-flash-preview': 250000,
  'gemini-2.5-flash': 250000,
  'gemini-2.5-flash-lite': 250000,

  // TTS：10K/分钟
  'gemini-2.5-flash-preview-tts': 10000,
  'gemini-3.1-flash-tts-preview': 10000,

  // Agent 模型（走 Interactions API）：100K/分钟
  'antigravity-preview-05-2026': 100000,
};

// 启发式估算输入 token 数（保守向，略微高估以降低超额风险）。
// 规则：每条 message 固定开销 4 token + 文本按 ~4 字符/token 估算（英文偏准，中文略低估但整体偏保守）。
// 覆盖 OpenAI 兼容格式的 messages（含多模态 parts 的 text）与顶层 system 字段。
export function estimateInputTokens(body) {
  if (!body || typeof body !== 'object') return 0;
  const texts = [];
  if (typeof body.system === 'string') texts.push(body.system);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m) continue;
      if (typeof m.content === 'string') {
        texts.push(m.content);
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part.text === 'string') texts.push(part.text);
        }
      }
    }
  }
  let total = 0;
  for (const t of texts) total += 4 + Math.ceil(t.length / 4);
  return total;
}
