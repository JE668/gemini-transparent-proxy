// lib/model-fallbacks.js
//
// 模型降级链（唯一数据源）。
//
// ⚠️ 历史上这份映射在 Vercel 端与 CF Worker 端各抄了一份，
//    改一边忘另一边 → 线上出现「同模型在两个部署目标行为不一致」。
//    现在统一放这里，两端都 import。
//
// 降级方向的原则：优先切到「额度更宽松」的模型。
//   - Flash 系列（RPD 20）  → Flash-Lite（RPD 500）
//   - Gemma 4（16K TPM）    → Flash-Lite（250K TPM）
//   - Agent 模型            → Flash-Lite
//
// 注意：降级目标必须在 lib/models.js 的 HIGH_QUOTA_MODELS 目录里，
// 否则降级后会 404 —— tests/sync.test.js 会守住这条不变量。

export const MODEL_FALLBACKS = {
  // Flash 系列 (RPD 20) → Flash-Lite (RPD 500)，日活撞墙时切高 RPD
  'gemini-3.8-flash': 'gemini-3.5-flash-lite',
  'gemini-3.6-flash': 'gemini-3.5-flash-lite',
  'gemini-3-flash-preview': 'gemini-2.5-flash',    // preview → stable 同 RPD
  'gemini-2.5-flash': 'gemini-3.5-flash-lite',
  'gemini-2.5-flash-lite': 'gemini-3.5-flash-lite',
  // Gemma 4 (16K TPM) → Flash-Lite (250K TPM)，TPM 撞墙时切高 TPM
  'gemma-4-31b-it': 'gemini-3.5-flash-lite',
  'gemma-4-26b-a4b-it': 'gemini-3.5-flash-lite',
  // Agent 模型 → Flash-Lite
  'antigravity-preview-05-2026': 'gemini-3.5-flash-lite',
};

export default MODEL_FALLBACKS;
