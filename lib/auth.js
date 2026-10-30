// lib/auth.js
// Dashboard API 端点的 Bearer 密码校验（运行时读取，Vercel/CF/本地通用）
//
// ⚠️ 为什么不用 middleware.js：Next.js 构建 Edge middleware 时会把
//   process.env.DASHBOARD_PASSWORD 静态内联进 bundle——之后在 Vercel 改
//   环境变量、redeploy，middleware 里仍是构建时的旧值，导致登录永远 401。
//   改为在各 route handler（Node runtime）里运行时读取 process.env，
//   改密码后重新部署即生效。
//
// ⚠️ 安全默认值：**生产环境未配置 DASHBOARD_PASSWORD 时不再默认放行**。
//    旧行为是「没配密码 = 不启用认证」，一旦忘记配置，/api/debug（可 SCAN 全部
//    Redis key）、/api/test-google（可真实调用上游）等端点就完全裸奔。
//    现在生产环境返回 503（配置缺失），开发环境仍放行以便本地起服务。
// 用法（受保护 route 的 GET 开头）：
//   import { isDashboardAuthed, unauthorizedResponse } from '../../../lib/auth';
//   export async function GET(req) {
//     if (!isDashboardAuthed(req)) return unauthorizedResponse();

export const AUTH_MODE_DISABLED = 'disabled';
export const AUTH_MODE_ENABLED = 'enabled';
export const AUTH_MODE_MISCONFIGURED = 'misconfigured';

/**
 * 判断当前认证模式：
 *   enabled       —— 已配置密码，正常校验
 *   disabled      —— 开发环境且未配置密码，放行（仅限本地开发）
 *   misconfigured —— 生产环境未配置密码，拒绝访问
 */
export function getAuthMode() {
  const password = process.env.DASHBOARD_PASSWORD;
  if (password) return AUTH_MODE_ENABLED;
  const isProduction = process.env.NODE_ENV === 'production'
    || process.env.VERCEL
    || process.env.VERCEL_ENV === 'production';
  return isProduction ? AUTH_MODE_MISCONFIGURED : AUTH_MODE_DISABLED;
}

/**
 * 恒定时间字符串比较，避免通过响应时间侧信道逐字符猜密码。
 * 长度不同也要走完同样轮数（先对双方做 padding）。
 */
function timingSafeEqual(a, b) {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] || 0) ^ (bBytes[i] || 0);
  }
  return diff === 0;
}

export function isDashboardAuthed(req) {
  const mode = getAuthMode();
  if (mode === AUTH_MODE_DISABLED) {
    console.warn('[auth] DASHBOARD_PASSWORD 未设置 —— 当前处于开发模式，/api/* 端点未受保护');
    return true;
  }
  if (mode === AUTH_MODE_MISCONFIGURED) {
    console.error('[auth] DASHBOARD_PASSWORD 未设置 —— 生产环境拒绝访问 /api/* 端点');
    return false;
  }
  const password = process.env.DASHBOARD_PASSWORD;
  const authHeader = req?.headers?.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  return timingSafeEqual(token, password);
}

export function unauthorizedResponse() {
  const mode = getAuthMode();
  if (mode === AUTH_MODE_MISCONFIGURED) {
    return Response.json(
      {
        status: 'error',
        message: '服务端未配置 DASHBOARD_PASSWORD，已禁用 Dashboard API。请设置该环境变量后重试。',
      },
      { status: 503 }
    );
  }
  return Response.json(
    { status: 'error', message: '未授权访问，请提供正确的密码' },
    { status: 401 }
  );
}
