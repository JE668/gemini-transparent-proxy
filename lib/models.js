// gemini-transparent-proxy/lib/models.js

export const HIGH_QUOTA_MODELS = [
  // ---------- Gemma 4 系列 (高配额, 1,500 req/day, 15 RPM) ----------
  {
    id: 'gemma-4-31b-it',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 1500,
    description: 'Gemma 4 31B (Dense) — 1,500 req/day (15 RPM) | 256K ctx ⭐ 主力'
  },
  {
    id: 'gemma-4-26b-a4b-it',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 1500,
    description: 'Gemma 4 26B A4B (MoE) — 1,500 req/day (15 RPM) | 256K ctx'
  },

  // ---------- Gemma 3 系列 (14,400 req/day, 30 RPM) ----------
  {
    id: 'gemma-3-27b-it',
    object: 'model',
    created: 1741996800,
    owned_by: 'google',
    limit: 14400,
    description: 'Gemma 3 27B — 14,400 req/day (30 RPM) | 128K ctx'
  },
  {
    id: 'gemma-3-12b-it',
    object: 'model',
    created: 1741996800,
    owned_by: 'google',
    limit: 14400,
    description: 'Gemma 3 12B — 14,400 req/day (30 RPM) | 128K ctx'
  },
  {
    id: 'gemma-3-4b-it',
    object: 'model',
    created: 1741996800,
    owned_by: 'google',
    limit: 14400,
    description: 'Gemma 3 4B — 14,400 req/day (30 RPM) | 128K ctx'
  },
  {
    id: 'gemma-3-2b-it',
    object: 'model',
    created: 1741996800,
    owned_by: 'google',
    limit: 14400,
    description: 'Gemma 3 2B — 14,400 req/day (30 RPM) | 128K ctx'
  },
  {
    id: 'gemma-3-1b-it',
    object: 'model',
    created: 1741996800,
    owned_by: 'google',
    limit: 14400,
    description: 'Gemma 3 1B — 14,400 req/day (30 RPM) | 128K ctx'
  },

  // ---------- Gemini 2.5 系列 ----------
  {
    id: 'gemini-2.5-flash-exp',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    limit: 10000,
    description: 'Gemini 2.5 Flash Exp — 10,000 req/day (250 RPM) | 1M ctx 🚀'
  },
  {
    id: 'gemini-2.5-pro-1p-freebie',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    limit: 500,
    description: 'Gemini 2.5 Pro (Trial) — 500 req/day (75 RPM) | 免费试用'
  },
  {
    id: 'gemini-2.5-flash',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    limit: 20,
    description: 'Gemini 2.5 Flash — 20 req/day (5 RPM) | 1M ctx ⚠️ 今日已达上限'
  },
  {
    id: 'gemini-2.5-flash-lite',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    limit: 20,
    description: 'Gemini 2.5 Flash-Lite — 20 req/day (10 RPM) | 1M ctx ⚠️ 今日已达上限'
  },
  {
    id: 'gemini-2.5-flash-tts',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    limit: 10,
    description: 'Gemini 2.5 Flash TTS — 10 req/day (3 RPM) | TTS 专用'
  },

  // ---------- Gemini 3 系列 ----------
  {
    id: 'gemini-3-flash',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    limit: 20,
    description: 'Gemini 3 Flash — 20 req/day (5 RPM) | 1M ctx'
  },
  {
    id: 'gemini-3.1-flash-lite',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    limit: 500,
    description: 'Gemini 3.1 Flash-Lite — 500 req/day (15 RPM)'
  },
  {
    id: 'gemini-3.1-flash-tts',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    limit: 10,
    description: 'Gemini 3.1 Flash TTS — 10 req/day (3 RPM) | TTS 专用'
  },

  // ---------- 其他免费模型 ----------
  {
    id: 'med-gemini',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    limit: 50000,
    description: 'Med-Gemini — 50,000 req/day (60 RPM) | 医学专用'
  },
  {
    id: 'learnlm-2.0-flash-experimental',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    limit: 1500,
    description: 'LearnLM 2.0 Flash — 1,500 req/day (15 RPM) | 学习专用'
  },
  {
    id: 'gemini-robotics-er-1.6-preview',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    limit: 20,
    description: 'Robotics ER 1.6 Preview — 20 req/day (5 RPM)'
  },
  {
    id: 'gemini-robotics-er-1.5-preview',
    object: 'model',
    created: 1740960000,
    owned_by: 'google',
    limit: 20,
    description: 'Robotics ER 1.5 Preview — 20 req/day (10 RPM)'
  }
];
