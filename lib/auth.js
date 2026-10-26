// lib/auth.js
// Dashboard API 端点的 Bearer 密码校验（运行时读取，Vercel/CF/本地通用）
//
// ⚠️ 为什么不用 middleware.js：Next.js 构建 Edge middleware 时会把
//   process.env.DASHBOARD_PASSWORD 静态内联进 bundle——之后在 Vercel 改
//   环境变量、redeploy，middleware 里仍是构建时的旧值，导致登录永远 401。
//   改为在各 route handler（Node runtime）里运行时读取 process.env，
//   改密码后重新部署即生效。
//
// 用法（受保护 route 的 GET 开头）：
//   import { isDashboardAuthed, unauthorizedResponse } from '../../../lib/auth';
//   export async function GET(req) {
//     if (!isDashboardAuthed(req)) return unauthorizedResponse();
//     ...

export function isDashboardAuthed(req) {
  const password = process.env.DASHBOARD_PASSWORD;
  // 未配置密码则不启用认证（向后兼容）
  if (!password) return true;
  const authHeader = req?.headers?.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  return token === password;
}

export function unauthorizedResponse() {
  return Response.json(
    { status: 'error', message: '未授权访问，请提供正确的密码' },
    { status: 401 }
  );
}
