/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // 在构建过程中忽略 ESLint 错误
    ignoreDuringBuilds: true,
  },
  typescript: {
    // 如果你有 tsconfig.json，也建议忽略类型检查
    ignoreBuildErrors: true,
  },
}

module.exports = nextConfig
