export const runtime = 'edge';

export async function GET() {
  // 只暴露必要的配置，不要输出完整 API Key
  const config = {
    version: '1.0.0',
    proxyBase: process.env.NEXT_PUBLIC_BASE_URL || 'https://api.170909.xyz',
    defaultModel: process.env.DEFAULT_MODEL || 'gemma-4-31b-it',
    modelsCount: 18,
    features: {
      streaming: true,
      openAICompat: true,
    },
  };
  return Response.json(config);
}
