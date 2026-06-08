// 测试生产环境 Dashboard 数据
const DASHBOARD_URL = 'https://api.170909.xyz';

// 用户，请先告诉我 Dashboard 密码，或者你在本地访问时看到的数据情况：
console.log(`
🔍 Dashboard 数据诊断

请访问生产环境 Dashboard 并告诉我以下信息：

1. 访问 URL: ${DASHBOARD_URL}/dashboard
2. 输入密码后，看到的现象是：
   - [ ] 所有卡片都显示"暂无数据"
   - [ ] 部分卡片有数据，部分没有
   - [ ] 数据为 0（请求数、延迟等都是 0）
   - [ ] 页面加载失败或报错

可能的原因：

1. ✅ Vercel 部署成功但还没有真实请求
   - 解决方案：用 curl 或 Postman 调用几次 API，产生一些请求数据

2. ⚠️ Redis 环境变量未配置
   - 检查：Vercel Settings → Environment Variables
   - 确认：UPSTASH_REDIS_REST_URL 和 UPSTASH_REDIS_REST_TOKEN 是否存在

3. ⚠️ Redis 实例是空的（新建的或清空的）
   - 正常现象，有请求后会自动写入数据

4. ⚠️ 代码有问题导致数据没写入
   - 需要查看 Vercel 部署日志和函数日志

请先访问 Dashboard 截图或描述看到的内容！
`);