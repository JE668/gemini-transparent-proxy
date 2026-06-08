// middleware.js
// Dashboard API 端点的 Bearer Token 认证保护
// 代理路由 /api/v1/*, /v1/* 等不受影响
// /dashboard 页面本身不拦截，由前端密码框 + API 401 处理认证

import { NextResponse } from 'next/server';

// 不需要认证的路由前缀（代理核心路径）
const PUBLIC_PREFIXES = [
  '/api/v1/',
  '/v1/',
  '/api/chat',
  '/api/completions',
  '/v1/chat',
  '/v1/completions',
];

// 需要认证的 API 路由前缀（不含 /dashboard 页面本身）
const PROTECTED_API_PREFIXES = [
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

function isProtectedAPI(pathname) {
  return PROTECTED_API_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

export function middleware(request) {
  const { pathname } = request.nextUrl;

  // 代理路由直接放行
  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  // 只拦截需要认证的 API 路由，/dashboard 页面放行
  if (!isProtectedAPI(pathname)) {
    return NextResponse.next();
  }

  // 如果未配置密码，则不启用认证（向后兼容）
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    return NextResponse.next();
  }

  // 校验 Bearer Token：Authorization: Bearer <password>
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (token && token === password) {
    return NextResponse.next();
  }

  // 返回 401，前端密码框会捕获并提示重新输入
  return NextResponse.json(
    { status: 'error', message: '未授权访问，请提供正确的密码' },
    { status: 401 }
  );
}

export const config = {
  matcher: [
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
