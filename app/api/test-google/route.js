// 调试端点：测试 Google API 连接
export async function GET() {
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
  const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent?key=${GOOGLE_API_KEY}`;
  
  const result = {
    hasKey: !!GOOGLE_API_KEY,
    keyPrefix: GOOGLE_API_KEY ? GOOGLE_API_KEY.slice(0, 10) + '...' : undefined,
    testUrl: testUrl.slice(0, 80) + '...',
    googleApiTest: null,
    error: null,
  };
  
  try {
    const response = await fetch(testUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Hi' }] }] })
    });
    
    result.googleApiTest = {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
    };
    
    const data = await response.json();
    if (!response.ok) {
      result.error = data;
    } else {
      result.success = true;
      result.response = data;
    }
  } catch (error) {
    result.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  
  return Response.json(result);
}