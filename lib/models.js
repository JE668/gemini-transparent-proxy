// gemini-transparent-proxy/lib/models.js

export const HIGH_QUOTA_MODELS = [
  // ---------- Gemma 4 系列 (主力高性能) ----------
  {
    id: 'gemma-4-31b-it',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 1500,
    description: 'Gemma 4 31B (Dense) — 1,500 req/day | 256K ctx ⭐ 主力'
  },
  {
    id: 'gemma-4-26b-a4b-it',
    object: 'model',
    created: 1743561600,
    owned_by: 'google',
    limit: 1500,
    description: 'Gemma 4 26B A4B (MoE) — 1,500 req/day | 256K ctx'
  },

  // ---------- Gemma 3 系列 (超高额度) ----------
  {
    id: 'gemma-3-27b-it',
    object: 'model',
    created: 1741996800,
    owned_by: 'google',
    limit: 14400,
    description: 'Gemma 3 27B — 14,400 req/day (30 RPM) | 128K ctx ⭐ 极速'
  },
  {
    id: 'gemma-3-12b-it',
    object: 'model',
    created: 1741996800,
    owned_by: 'google',
    limit: 14400,
    description: 'Gemma 3 12B — 14,400 req/day (30 RPM) | 128K ctx'
  },

  // ---------- Gemini 2.5 系列 (高额度/特权) ----------
  {
    id: 'gemini-2.5-flash-exp',
    object: 'model',
    created: 1741996800,
    owned_by: 'google',
    limit: 10000,
    description: 'Gemini 2.5 Flash Exp — 10,000 req/day ⭐ 强力'
  },
  {
    id: 'gemini-2.5-pro-1p-freebie',
    object: 'model',
    created: 1741996800,
    owned_by: 'google',
    limit: 500,
    description: 'Gemini 2.5 Pro Freebie — 500 req/day | 复杂推理'
  },
];
