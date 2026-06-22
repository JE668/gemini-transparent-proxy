/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  // 代理路由的 CORS 由 route handler 中的 getCorsHeaders() 动态控制
  // Dashboard 页面由前端密码框保护，无需全局 CORS
  // 此处仅对非 API 静态资源添加宽松 CORS；代理路由的 CORS 由代码按环境变量决定
  async headers() {
    return [
      {
        // 缩小范围：仅对静态资源和 dashboard 页面加 CORS，不覆盖 API 代理路由
        // 代理路由的 CORS 由 route handler 精细控制
        source: '/((?!api/v1/|v1/|api/).*)',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: '*' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
