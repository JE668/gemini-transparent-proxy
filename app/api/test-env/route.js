// 测试 API：返回当前环境变量和请求详情
export async function GET(request: Request) {
  return Response.json({
    hasGoogleKey: !!process.env.GOOGLE_API_KEY,
    googleKeyPrefix: process.env.GOOGLE_API_KEY ? process.env.GOOGLE_API_KEY.slice(0, 8) + '...' : undefined,
    nodeEnv: process.env.NODE_ENV,
    vercelRegion: process.env.VERCEL_REGION,
    timestamp: new Date().toISOString(),
  });
}