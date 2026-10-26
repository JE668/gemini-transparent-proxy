import { isDashboardAuthed, unauthorizedResponse } from '../../../lib/auth';
import { HIGH_QUOTA_MODELS } from '../../../lib/models';

export const runtime = 'nodejs';

export async function GET(req) {
  if (!isDashboardAuthed(req)) return unauthorizedResponse();
  // 只暴露必要的配置，不要输出完整 API Key
  const config = {
    version: '1.1.0-debug',
    deploy_timestamp: new Date().toISOString(),
    proxyBase: process.env.NEXT_PUBLIC_BASE_URL || 'https://your-domain.com',
    defaultModel: process.env.DEFAULT_MODEL || 'gemma-4-31b-it',
    modelsCount: HIGH_QUOTA_MODELS.length,
    features: {
      streaming: true,
      openAICompat: true,
    },
  };
  return Response.json(config);
}
