/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: true,
  },
  // CORS 头由 route handler 中的 getCorsHeaders() 动态控制
  // 此处仅对非 API 静态资源添加宽松 CORS；代理路由的 CORS 由代码按环境变量决定
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // 对于非浏览器 JS 调用的场景（如 curl），宽松 CORS 仍然需要
          // 精细控制请在 CORS_ALLOWED_ORIGINS 环境变量中配置
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: '*' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
