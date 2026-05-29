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

 // ---------- Gemma 3 系列 ----------
 {
 id: 'gemma-3-27b-it',
 object: 'model',
 created: 1741996800,
 owned_by: 'google',
 limit: 14400,
 description: 'Gemma 3 27B — 14,400 req/day (30 RPM) | 128K ctx'
 },
];
