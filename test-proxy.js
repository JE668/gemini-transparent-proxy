#!/usr/bin/env node
// 测试代理 API
const GOOGLE_API_KEY = process.argv[2];

if (!GOOGLE_API_KEY) {
  console.error('用法：node test-proxy.js <your-google-api-key>');
  process.exit(1);
}

async function test() {
  console.log('🔍 测试代理 API...\n');
  
  const url = 'https://api.170909.xyz/v1/chat/completions';
  
  const body = {
    model: 'gemma-4-31b-it',
    messages: [{ role: 'user', content: 'Hello' }]
  };
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GOOGLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    
    console.log(`状态码：${response.status} ${response.statusText}`);
    console.log(`\n响应头:`);
    response.headers.forEach((v, k) => console.log(`  ${k}: ${v}`));
    
    const text = await response.text();
    console.log(`\n响应体:`);
    try {
      const json = JSON.parse(text);
      console.log(JSON.stringify(json, null, 2));
    } catch {
      console.log(text);
    }
    
    if (response.status === 502) {
      console.log('\n❌ 502 错误：代理服务器无法连接到上游 Gemini API');
      console.log('可能原因:');
      console.log('  1. Google API Key 无效或过期');
      console.log('  2. Vercel 环境变量 GOOGLE_API_KEY 未设置');
      console.log('  3. Google API 服务暂时不可用');
    }
  } catch (error) {
    console.error('❌ 请求失败:', error.message);
  }
}

test();