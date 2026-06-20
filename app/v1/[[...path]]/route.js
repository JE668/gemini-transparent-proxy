// Re-export from /api/[[...path]]
export { GET, POST, PUT, DELETE, OPTIONS } from '../../api/[[...path]]/route';

// 必须显式导出 runtime 配置，否则 /v1/ 路径会跑默认的 Edge Runtime (30s → 504)
export const runtime = 'nodejs';
export const maxDuration = 60;