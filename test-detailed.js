#!/usr/bin/env node
// 详细测试代理 API
const GOOGLE_API_KEY = process.argv[2];

if (!GOOGLE_API_KEY) {
  console.error('用法：node test-detailed.js <your-google-api-key>');
  process.exit(1);
}

async function test() {
  console.log('🔍 详细测试代理 API...\n');
  console.log(`API Key: ${GOOGLE_API_KEY.slice(0, 8)}...${GOOGLE_API_KEY.slice(-4)}`);
  console.log(`代理地址：https://api.170909.xyz/v1/chat/completions\n`);
  
  // 测试 1: 直接调用 Google API（验证 Key 是否有效）
  console.log('📞 测试 1: 直接调用 Google API...');
  try {
    const directUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent?key=${GOOGLE_API_KEY}`;
    const directResp = await fetch(directUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Hi' }] }] })
    });
    console.log(`   直接调用 Google: ${directResp.status} ${directResp.statusText}`);
    if (directResp.status !== 200) {
      const errText = await directResp.text();
      console.log(`   ❌ Google API 错误：${errText.slice(0, 200)}`);
      console.log('\n   可能原因：');
      console.log('   1. API Key 无效或过期');
      console.log('   2. API Key 配额已用完');
      console.log('   3. 网络无法访问 Google（需要代理）');
      return;
    }
    console.log('   ✅ Google API Key 有效\n');
  } catch (e) {
    console.log(`   ❌ 直接调用失败：${e.message}`);
    console.log('   可能网络无法访问 Google API\n');
  }
  
  // 测试 2: 通过代理调用
  console.log('📞 测试 2: 通过代理调用...');
  const proxyUrl = 'https://api.170909.xyz/v1/chat/completions';
  const body = {
    model: 'gemma-4-31b-it',
    messages: [{ role: 'user', content: 'Hello' }]
  };
  
  try {
    const response = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GOOGLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    
    console.log(`   状态码：${response.status} ${response.statusText}`);
    
    const text = await response.text();
    
    if (response.status === 200) {
      console.log('   ✅ 代理工作正常！');
      const json = JSON.parse(text);
      if (json.choices?.[0]?.message?.content) {
        console.log(`   回复：${json.choices[0].message.content.slice(0, 100)}`);
      }
    } else if (response.status === 404) {
      console.log('   ❌ 404 Not Found - 路由不存在');
      console.log('   可能原因：');
      console.log('   1. Vercel 部署的不是最新代码');
      console.log('   2. 动态路由 [[...path]] 没有正确编译');
      console.log('   3. 文件结构有问题');
    } else if (response.status === 502) {
      console.log('   ❌ 502 Bad Gateway - 上游连接失败');
      console.log('   可能原因：');
      console.log('   1. Vercel 环境变量 GOOGLE_API_KEY 未设置');
      console.log('   2. Google API 服务不可用');
      console.log('   3. 代理代码有 bug 导致崩溃');
    } else {
      console.log(`   ❌ 错误：${text.slice(0, 200)}`);
    }
  } catch (error) {
    console.error(`   ❌ 请求失败：${error.message}`);
  }
}

test();