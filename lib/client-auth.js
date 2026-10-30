// lib/client-auth.js
// 客户端 API Key 提取与校验（与 Dashboard 密码认证无关）
//
// 用途：`/v1/models` 这类「会暴露服务能力清单」的端点此前完全公开，
// 任何人都能拿到完整模型目录与配额信息。README 的端点表也明确写了
// `/v1/models` 需要 Google API Key。统一在这里做校验，保证 Vercel 与 CF 两端一致。

/**
 * 从请求头提取 Bearer token。
 *
 * ⚠️ 必须校验认证方案：只做「剥离 Bearer 前缀」是不够的 ——
 *    `Authorization: Basic dXNlcjpwYXNz` 会被原样返回，
 *    导致 hasApiKey() 把任意认证头误判成有效 API Key，
 *    /v1/models 这类端点就会对非 Bearer 凭据放行。
 *    非 Bearer 方案一律返回空字符串。
 *
 * @param {Request} req
 * @returns {string} 未携带或格式不对时返回空字符串
 */
export function extractBearerToken(req) {
  const header = req?.headers?.get?.('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

/**
 * 是否携带了有效的（格式上）API Key。
 * 注意：这里只判断「有没有带凭据」，不校验凭据本身是否有效 —— 真正的校验
 * 由上游 Google 完成；代理侧只负责不把能力清单暴露给匿名访客。
 */
export function hasApiKey(req) {
  return extractBearerToken(req).length > 0;
}

export function missingApiKeyResponse() {
  return Response.json(
    {
      error: {
        message: '缺少 API Key，请在请求头中提供 Authorization: Bearer <your-google-api-key>',
        type: 'invalid_request_error',
        code: 'missing_api_key',
      },
    },
    { status: 401 }
  );
}
