import { isDashboardAuthed, unauthorizedResponse } from '../../../lib/auth';
// 调试端点：测试 Google API 连接
//
// ⚠️ 安全：旧实现会把 error.stack（含本机路径与调用栈）、Google API Key 前 10 位
//    以及拼了完整 Key 的 testUrl 一并回显。这里全部去掉：
//    · 不再返回 stack，只返回错误类型与 message
//    · 不再返回 Key 前缀
//    · testUrl 一律脱敏
export async function GET(req) {
  if (!isDashboardAuthed(req)) return unauthorizedResponse();
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
  // ⚠️ 鉴权走 header，不再把 Key 拼进 URL query
  const testUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent';

  const result = {
    hasKey: !!GOOGLE_API_KEY,
    testUrl,
    googleApiTest: null,
    error: null,
  };

  try {
    const response = await fetch(testUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(GOOGLE_API_KEY ? { 'x-goog-api-key': GOOGLE_API_KEY } : {}),
      },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Hi' }] }] })
    });

    result.googleApiTest = {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
    };

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // 只回传 Google 返回的错误消息本身，不含本地堆栈
      result.error = {
        message: data?.error?.message || `${response.status} ${response.statusText}`,
        code: data?.error?.code || response.status,
      };
    } else {
      result.success = true;
      result.response = data;
    }
  } catch (error) {
    result.error = {
      name: error.name,
      message: error.message,
    };
  }

  return Response.json(result);
}
