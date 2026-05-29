// middleware.js
// Dashboard 与内部 API 端点的 Basic Auth 认证保护
// 代理路由 /api/v1/*, /v1/*, /api/chat* 等不受影响

import { NextResponse } from 'next/server';

// 不需要认证的路由前缀（代理核心路径）
const PUBLIC_PREFIXES = [
  '/api/v1/',
  '/v1/',
  '/api/chat',
  '/api/completions',
];

// 需要认证的路由前缀
const PROTECTED_PREFIXES = [
  '/dashboard',
  '/api/quota',
  '/api/health',
  '/api/errors',
  '/api/timeline',
  '/api/clients',
  '/api/recent',
  '/api/config',
];

function isPublic(pathname) {
  return PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

function isProtected(pathname) {
  return PROTECTED_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

export function middleware(request) {
  const { pathname } = request.nextUrl;

  // 代理路由直接放行
  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  // 非保护路由直接放行（静态资源等）
  if (!isProtected(pathname)) {
    return NextResponse.next();
  }

  // 如果未配置密码，则不启用认证（向后兼容）
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    return NextResponse.next();
  }

  // 校验 Basic Auth
  const authHeader = request.headers.get('authorization');
  if (authHeader) {
    const encoded = authHeader.replace(/^Basic\s+/i, '');
    try {
      const decoded = atob(encoded);
      // 格式: admin:password
      const colonIndex = decoded.indexOf(':');
      if (colonIndex !== -1) {
        const providedPassword = decoded.slice(colonIndex + 1);
        if (providedPassword === password) {
          return NextResponse.next();
        }
      }
    } catch {
      // base64 解码失败，继续返回 401
    }
  }

  // 返回 401，浏览器弹出 Basic Auth 对话框
  return new NextResponse('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Gemini Proxy Dashboard", charset="UTF-8"',
      'Content-Type': 'text/plain',
    },
  });
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/api/quota/:path*',
    '/api/health/:path*',
    '/api/errors/:path*',
    '/api/timeline/:path*',
    '/api/clients/:path*',
    '/api/recent/:path*',
    '/api/config/:path*',
    '/api/v1/:path*',
    '/v1/:path*',
    '/api/chat/:path*',
    '/api/completions/:path*',
  ],
};
