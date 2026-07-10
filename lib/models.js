// gemini-transparent-proxy/lib/models.js
//
// 免费层（Google AI Studio free tier）可用的「文本生成」模型目录。
// 数据来源：generativelanguage.googleapis.com 控制台配额导出（2026-07-10 快照）。
//
// 约定：
//   - limit 字段 = 免费层 RPD（每天请求数），供 /api/quota 与 Dashboard 配额求和使用。
//   - description 内标注 RPM / RPD / TPM（输入 token/分钟），TPM=inf 表示"无限制"。
//   - 本目录仅用于 /v1/models 对外展示，真实请求使用的模型名来自客户端请求体，与此无关。
//
// 说明：下列 id 为免费层可调用的真实模型名。gemma-4 两个 id 带 -it / -a4b 后缀，
//      与项目 DEFAULT_MODEL、MODEL_FALLBACKS 降级链保持一致（控制台配额 key 为 gemma-4-31b / gemma-4-26b 家族）。
//
// 未纳入本目录的免费层模态（端点形态不同，非 OpenAI 文本 Chat Completions）：
//   - 实时/音频对话类：gemini-2.5-flash-live、gemini-2.5-flash-native-audio-dialog、
//     gemini-3-flash-live、gemini-3.5-live-translate（均为 RPM/RPD 无限制，按会话计）
//   - 图像 Imagen：Imagen 4.0 fast 70 张/天、ultra 30 张/天、3.0 5 张/天
//   - 嵌入 Embedding：gemini-embedding 1.0/2 = 100 RPM / 1,000 RPD / 30,000 TPM

export const HIGH_QUOTA_MODELS = [
  // ---------- Gemma 4 系列 (主力高性能, 免费层 1,500 req/day) ----------
  {
    id: 'gemma-4-31b-it',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 1500,
    description: 'Gemma 4 31B (Dense) — RPM 15 | RPD 1,500 | TPM 无限 ⭐ 主力'
  },
  {
    id: 'gemma-4-26b-a4b-it',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 1500,
    description: 'Gemma 4 26B A4B (MoE) — RPM 15 | RPD 1,500 | TPM 无限'
  },

  // ---------- Gemma 3 系列 (免费层 RPM 30 | RPD 14,400 | TPM 15,000) ----------
  {
    id: 'gemma-3-1b',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 14400,
    description: 'Gemma 3 1B — RPM 30 | RPD 14,400 | TPM 15,000'
  },
  {
    id: 'gemma-3-2b',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 14400,
    description: 'Gemma 3 2B — RPM 30 | RPD 14,400 | TPM 15,000'
  },
  {
    id: 'gemma-3-4b',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 14400,
    description: 'Gemma 3 4B — RPM 30 | RPD 14,400 | TPM 15,000'
  },
  {
    id: 'gemma-3-12b',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 14400,
    description: 'Gemma 3 12B — RPM 30 | RPD 14,400 | TPM 15,000'
  },
  {
    id: 'gemma-3-27b',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 14400,
    description: 'Gemma 3 27B — RPM 30 | RPD 14,400 | TPM 15,000'
  },

  // ---------- Gemini 2.5 系列 ----------
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
  {
    id: 'gemini-2.5-flash-tts',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 10,
    description: 'Gemini 2.5 Flash TTS (语音合成) — RPM 3 | RPD 10 | TPM 10,000'
  },
  {
    id: 'gemini-2.5-pro-1p-freebie',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 500,
    description: 'Gemini 2.5 Pro (1p freebie 特殊免费额度) — RPM 75 | RPD 500 | TPM 1,000,000'
  },
  {
    id: 'gemini-2.5-flash-exp',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 10000,
    description: 'Gemini 2.5 Flash (实验版 exp) — RPM 250 | RPD 10,000 | TPM 1,000,000'
  },

  // ---------- Gemini 3 / 3.5 系列 ----------
  {
    id: 'gemini-3-flash',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 20,
    description: 'Gemini 3 Flash — RPM 5 | RPD 20 | TPM 250,000'
  },
  {
    id: 'gemini-3.5-flash',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 20,
    description: 'Gemini 3.5 Flash — RPM 5 | RPD 20 | TPM 250,000'
  },

  // ---------- Gemini 3.1 系列 ----------
  {
    id: 'gemini-3.1-flash-lite',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 500,
    description: 'Gemini 3.1 Flash-Lite — RPM 15 | RPD 500 | TPM 250,000'
  },
  {
    id: 'gemini-3.1-flash-tts',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 10,
    description: 'Gemini 3.1 Flash TTS (语音合成) — RPM 3 | RPD 10 | TPM 10,000'
  },
];
