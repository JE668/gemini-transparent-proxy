// gemini-transparent-proxy/lib/models.js
//
// 免费层（Google AI Studio free tier）可用模型目录。
//
// 数据来源（双重校验）：
//   1. generativelanguage.googleapis.com 控制台配额导出（2026-07-10 快照）→ 提供免费层 RPM/RPD/TPM。
//      ⚠️ 2026-07-21 核对：Gemma 4 的 TPM 已由「无限」收紧为 16K/分钟（新模型发布后典型「先宽松后收紧」），详见 TPM_LIMITS。
//   2. Google ListModels 接口（GET /v1beta/models）实测该 key 下的可调用模型名 → 作为 id 真伪的最终依据。
//
// 约定：
//   - 每个 id 均已通过 ListModels 实测确认为「真实可调用」的模型名（非配额统计维度名）。
//   - limit 字段 = 免费层 RPD（每天请求数），供 /api/quota 与 Dashboard 配额求和使用。
//   - description 内标注 RPM / RPD / TPM（输入 token/分钟），TPM=无限 表示不限。
//   - 本目录仅用于 /v1/models 对外展示，真实请求使用的模型名来自客户端请求体，与此无关。
//
// ⚠️ 实测修正记录（相较配额表推断）：
//   - gemma-3 全系（1b/2b/4b/12b/27b）在 ListModels 中不存在 → 已全部移除（该 key 不可调用）。
//   - gemini-2.5-flash-exp 在 ListModels 中不存在 → 已移除。
//   - 配额维度名 → 真实可调用名：gemini-3-flash→gemini-3-flash-preview、
//     gemini-2.5-flash-tts→gemini-2.5-flash-preview-tts、gemini-3.1-flash-tts→gemini-3.1-flash-tts-preview。
//   - gemma-4 两个 id 带 -it / -a4b 后缀，与 DEFAULT_MODEL、MODEL_FALLBACKS 降级链保持一致。
//
// 📌 本目录仅列出走文本 Chat Completions（generateContent）端点的模型。
//    Imagen（predict，文生图）与 Embedding（embedContent，向量嵌入）端点形态不同，
//    不适合混入 /v1/models 目录（会误导客户端选型），其免费层额度与调用端点详见 README「免费层额度速查表」。
//    Agent 模型（Deep Research / Antigravity）走 Interactions API，也列入目录供客户端发现，
//    实际使用时会自动路由到 Interactions API。

export const HIGH_QUOTA_MODELS = [
  // ============ 文本对话 · 主力高配额 ============
  {
    id: 'gemma-4-31b-it',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 14400,
    description: 'Gemma 4 31B (Dense) — RPM 30 | RPD 14,400 | TPM 16,000 ⭐ 主力'
  },
  {
    id: 'gemma-4-26b-a4b-it',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 14400,
    description: 'Gemma 4 26B A4B (MoE) — RPM 30 | RPD 14,400 | TPM 16,000'
  },
  {
    id: 'gemini-3.5-flash-lite',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 500,
    description: 'Gemini 3.5 Flash-Lite — RPM 15 | RPD 500 | TPM 250,000 ⭐ 推荐'
  },
  {
    id: 'gemini-3.1-flash-lite',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 500,
    description: 'Gemini 3.1 Flash-Lite — RPM 15 | RPD 500 | TPM 250,000'
  },

  // ============ 文本对话 · 低配额（RPD 20，放置底部） ============
  {
    id: 'gemini-3.6-flash',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 20,
    description: 'Gemini 3.6 Flash — RPM 5 | RPD 20 | TPM 250,000'
  },
  {
    id: 'gemini-3.5-flash',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 20,
    description: 'Gemini 3.5 Flash — RPM 5 | RPD 20 | TPM 250,000'
  },
  {
    id: 'gemini-3-flash-preview',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 20,
    description: 'Gemini 3 Flash (Preview) — RPM 5 | RPD 20 | TPM 250,000'
  },
  {
    id: 'gemini-2.5-flash',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 20,
    description: 'Gemini 2.5 Flash — RPM 5 | RPD 20 | TPM 250,000'
  },
  {
    id: 'gemini-2.5-flash-lite',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 20,
    description: 'Gemini 2.5 Flash-Lite — RPM 10 | RPD 20 | TPM 250,000'
  },
  // ============ 语音合成 TTS（放置底部，RPD 10） ============
  {
    id: 'gemini-2.5-flash-preview-tts',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 10,
    description: 'Gemini 2.5 Flash TTS (语音合成) — RPM 3 | RPD 10 | TPM 10,000'
  },
  {
    id: 'gemini-3.1-flash-tts-preview',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 10,
    description: 'Gemini 3.1 Flash TTS (语音合成) — RPM 3 | RPD 10 | TPM 10,000'
  },

  // ============ Agent 模型（走 Interactions API） ============
  {
    id: 'antigravity-preview-05-2026',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 100,
    description: 'Antigravity Agent — RPM 60 | RPD 100 | TPM 100,000'
  },
  {
    id: 'deep-research-preview-04-2026',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 50,
    description: 'Deep Research Agent — ⚡ 走 Interactions API, 用于深度研究'
  },
  {
    id: 'deep-research-max-preview-04-2026',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 20,
    description: 'Deep Research Max Agent — ⚡ 走 Interactions API, 深度研究增强版'
  },
];
