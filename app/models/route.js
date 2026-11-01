// 无前缀 /models 端点：DSH 客户端用 new URL("/models", baseURL.origin) 拉取模型列表，
// 不携带 baseURL 的路径前缀（如 /v1）。CF Worker 天然处理任意路径，但 Vercel 的
// app/api/[[...path]] catch-all 只匹配 /api/...，导致 /models 返回 404。
// 此路由把 /models 交给 /api/[[...path]] 的统一处理逻辑，保证 Vercel/CF 行为一致。
export { GET, POST, PUT, DELETE, OPTIONS } from '../api/[[...path]]/route';

// 必须显式导出 runtime 配置，否则默认 Edge Runtime (30s → 504)
export const runtime = 'nodejs';
export const maxDuration = 60;
