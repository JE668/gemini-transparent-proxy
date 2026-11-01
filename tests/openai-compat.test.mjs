// tests/openai-compat.test.js
//
// 请求体清洗 / URL 映射的回归测试。
// 这些函数直接决定「发给 Google 的 body 长什么样」，一旦被改坏，
// 会表现为 400、工具调用失效、参数漂移等难以定位的问题，故逐条钉死行为。
//
// 运行：npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GOOGLE_API_BASE,
  GOOGLE_OPENAI_BLOCKED,
  sanitizeOpenAIBody,
  cleanTools,
  cleanMessages,
  injectThoughtSignature,
  buildTargetUrl,
} from '../lib/openai-compat.js';

test('GOOGLE_OPENAI_BLOCKED 覆盖已知不被 Google 接受的字段', () => {
  for (const f of [
    'stream_options', 'reasoning_effort', 'frequency_penalty', 'presence_penalty',
    'logit_bias', 'logprobs', 'top_logprobs', 'seed', 'user', 'service_tier',
    'n', 'include_reasoning', 'store', 'metadata', 'parallel_tool_calls', 'response_format',
  ]) {
    assert.ok(GOOGLE_OPENAI_BLOCKED.has(f), `缺少被屏蔽字段 ${f}`);
  }
});

test('sanitizeOpenAIBody: 去掉黑名单字段', () => {
  const body = JSON.stringify({
    model: 'gemini-3.5-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high',
    response_format: { type: 'json_object' },
    n: 2,
    seed: 42,
  });
  const out = JSON.parse(sanitizeOpenAIBody(body));
  assert.equal(out.model, 'gemini-3.5-flash-lite');
  assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }]);
  for (const k of ['reasoning_effort', 'response_format', 'n', 'seed']) {
    assert.equal(k in out, false, `${k} 应被移除`);
  }
});

test('sanitizeOpenAIBody: 去掉 null 值字段，但保留 null 之外的 falsy 值', () => {
  const out = JSON.parse(sanitizeOpenAIBody(JSON.stringify({
    model: 'm', a: null, b: 0, c: false, d: '', e: undefined,
  })));
  assert.equal('a' in out, false, 'null 字段应被移除');
  assert.equal(out.b, 0, '数字 0 应保留');
  assert.equal(out.c, false, 'false 应保留');
  assert.equal(out.d, '', '空字符串应保留');
});

test('sanitizeOpenAIBody: tools 递归清洗，只保留 name/description/parameters', () => {
  const body = JSON.stringify({
    model: 'm',
    tools: [{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        strict: true,
      },
    }],
  });
  const out = JSON.parse(sanitizeOpenAIBody(body));
  assert.deepEqual(out.tools[0].function, {
    name: 'read_file',
    description: 'read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  });
  assert.equal('strict' in out.tools[0].function, false, 'strict 必须被剥离（Google 会 500）');
  assert.equal(out.tools[0].type, 'function', 'tool.type 属于外层，应保留');
});

test('sanitizeOpenAIBody: 非 JSON body 原样透传', () => {
  const raw = 'not-json-at-all';
  assert.equal(sanitizeOpenAIBody(raw), raw);
});

test('sanitizeOpenAIBody: 空 body 与 "{}" 原样返回', () => {
  assert.equal(sanitizeOpenAIBody(''), '');
  assert.equal(sanitizeOpenAIBody('{}'), '{}');
  assert.equal(sanitizeOpenAIBody(null), null);
});

test('cleanTools: 没有 function 字段的条目原样保留', () => {
  const tools = [{ type: 'web_search' }];
  assert.deepEqual(cleanTools(tools), tools);
});

test('cleanTools: function 里缺字段时不补 undefined 键', () => {
  const out = cleanTools([{ type: 'function', function: { name: 'f' } }]);
  assert.deepEqual(Object.keys(out[0].function), ['name']);
});

test('buildTargetUrl: OpenAI 兼容路径映射', () => {
  assert.equal(
    buildTargetUrl('/v1/chat/completions', ''),
    `${GOOGLE_API_BASE}/v1beta/openai/chat/completions`,
  );
  assert.equal(
    buildTargetUrl('/api/v1/chat/completions', ''),
    `${GOOGLE_API_BASE}/v1beta/openai/chat/completions`,
  );
  assert.equal(
    buildTargetUrl('/api/v1/responses', ''),
    `${GOOGLE_API_BASE}/v1beta/openai/responses`,
  );
});

test('buildTargetUrl: /api/ 前缀走原生 Gemini 端点（不再误加 openai 前缀）', () => {
  // ⚠️ 回归：旧规则把 `/api/` 一律改写成 `/v1beta/openai/`，
  //    导致原生端点变成 `/v1beta/openai/v1beta/models/...` 必然 404。
  assert.equal(
    buildTargetUrl('/api/models/gemma-4-31b-it:generateContent', ''),
    `${GOOGLE_API_BASE}/v1beta/models/gemma-4-31b-it:generateContent`,
  );
  assert.equal(
    buildTargetUrl('/api/v1beta/models/imagen-4.0-fast-generate-001:predict', ''),
    `${GOOGLE_API_BASE}/v1beta/models/imagen-4.0-fast-generate-001:predict`,
  );
  assert.equal(
    buildTargetUrl('/api/v1beta/models/text-embedding-004:embedContent', ''),
    `${GOOGLE_API_BASE}/v1beta/models/text-embedding-004:embedContent`,
  );
});

test('buildTargetUrl: 原生 Google 端点不被改写', () => {
  assert.equal(
    buildTargetUrl('/v1beta/models/gemma-4-31b-it:generateContent', ''),
    `${GOOGLE_API_BASE}/v1beta/models/gemma-4-31b-it:generateContent`,
  );
});

test('buildTargetUrl: 保留 query string', () => {
  assert.equal(
    buildTargetUrl('/v1/chat/completions', '?alt=sse'),
    `${GOOGLE_API_BASE}/v1beta/openai/chat/completions?alt=sse`,
  );
});

test('cleanMessages: 普通 role 消息原样保留', () => {
  const messages = [
    { role: 'system', content: 'You are a bot' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
  ];
  const out = cleanMessages(messages);
  assert.deepEqual(out, messages, 'system/user/assistant 消息应保留所有标准字段');
});

test('cleanMessages: tool role 消息透传 thought_signature', () => {
  const messages = [
    { role: 'tool', tool_call_id: 'call_1', content: 'result', thought_signature: 'abc123sig' },
  ];
  const out = cleanMessages(messages);
  assert.deepEqual(out, [{ role: 'tool', tool_call_id: 'call_1', content: 'result', thought_signature: 'abc123sig' }]);
});

test('cleanMessages: function role 消息透传 thought_signature', () => {
  const messages = [
    { role: 'function', name: 'bash', content: 'result', thought_signature: 'def456sig' },
  ];
  const out = cleanMessages(messages);
  assert.deepEqual(out, [{ role: 'function', name: 'bash', content: 'result', thought_signature: 'def456sig' }]);
});

test('cleanMessages: tool role 无 thought_signature 时不添加', () => {
  const messages = [
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
  ];
  const out = cleanMessages(messages);
  assert.deepEqual(out, [{ role: 'tool', tool_call_id: 'call_1', content: 'result' }]);
  assert.equal('thought_signature' in out[0], false, '没有 thought_signature 时不应添加该键');
});

test('sanitizeOpenAIBody: 保留 messages 中 function call 的 thought_signature', () => {
  const body = JSON.stringify({
    model: 'gemini-4-thinking',
    messages: [
      { role: 'user', content: 'run bash' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'output', thought_signature: 'abc123sig' },
    ],
    tools: [{ type: 'function', function: { name: 'bash', description: 'run cmd', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }],
  });
  const out = JSON.parse(sanitizeOpenAIBody(body));
  assert.equal(out.messages[2].thought_signature, 'abc123sig', 'tool 消息的 thought_signature 必须透传');
  assert.deepEqual(out.tools[0].function, {
    name: 'bash',
    description: 'run cmd',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
  }, 'tools 仍应被 cleanTools 清洗');
});

test('cleanMessages: assistant 消息的 tool_calls 归一化 thought_signature 到 Google 要求位置', () => {
  // ⚠️ 客户端回传时可能把 sig 放在顶层 tool_calls[].thought_signature（非 Google 要求位置），
  //    必须归一化到 tool_calls[].extra_content.google.thought_signature（Google 实测要求的位置）。
  const messages = [
    { role: 'assistant', content: null, tool_calls: [{
      id: 'call_1', type: 'function',
      function: { name: 'bash', arguments: '{"cmd":"ls"}' },
      thought_signature: 'top_sig_123',
    }] },
  ];
  const out = cleanMessages(messages);
  assert.equal(out[0].tool_calls[0].extra_content.google.thought_signature, 'top_sig_123', '顶层 sig 必须归一化到 extra_content.google');
  assert.equal(out[0].tool_calls[0].thought_signature, 'top_sig_123', '顶层 sig 应保留一份');
});

test('cleanMessages: assistant 消息的 tool_calls 已带 extra_content.google.thought_signature 时保持', () => {
  // Google 正确位置，不应被破坏
  const messages = [
    { role: 'assistant', content: null, tool_calls: [{
      id: 'call_2', type: 'function',
      function: { name: 'browser_open', arguments: '{"url":"https://example.com"}' },
      extra_content: { google: { thought_signature: 'ec_sig_456' } },
    }] },
  ];
  const out = cleanMessages(messages);
  assert.deepEqual(out[0].tool_calls[0].extra_content, { google: { thought_signature: 'ec_sig_456' } }, '已有 extra_content 不应被破坏');
  assert.equal(out[0].tool_calls[0].thought_signature, 'ec_sig_456', '应同步一份到顶层');
});

test('cleanMessages: assistant 消息的 tool_calls 无 thought_signature 时保持不变', () => {
  const messages = [
    { role: 'assistant', content: null, tool_calls: [{
      id: 'call_3', type: 'function',
      function: { name: 'bash', arguments: '{"cmd":"ls"}' },
    }] },
  ];
  const out = cleanMessages(messages);
  assert.equal(out[0].tool_calls[0].extra_content, undefined, '无 sig 时不应添加 extra_content');
});

test('injectThoughtSignature: gemma-4-26b-a4b-it 返回模型级固定 sig', () => {
  // ⚠️ 实测：gemma-4-26b-a4b-it 的 thought_signature 是模型级固定常量
  //    （解码后为固定 UUID e24830a7-...），与对话内容/会话无关。
  const sig = injectThoughtSignature('gemma-4-26b-a4b-it');
  assert.equal(sig, 'EiYKJGUyNDgzMGE3LTVjZDYtNDJmZS05OThiLWVlNTM5ZTcyYjljMw==');
});

test('injectThoughtSignature: gemma-4-31b-it 也返回同一模型家族固定 sig（修复 400）', () => {
  // ⚠️ 实测：gemma-4-31b-it 的 thought_signature 与 gemma-4-26b-a4b-it 完全相同
  //    （同一模型家族）。此前不在注入表 → DSH/Reasonix 调用时缺 sig → Google 400。
  const sig = injectThoughtSignature('gemma-4-31b-it');
  assert.equal(sig, 'EiYKJGUyNDgzMGE3LTVjZDYtNDJmZS05OThiLWVlNTM5ZTcyYjljMw==');
});

test('injectThoughtSignature: 兼容 models/ 前缀', () => {
  assert.equal(
    injectThoughtSignature('models/gemma-4-26b-a4b-it'),
    'EiYKJGUyNDgzMGE3LTVjZDYtNDJmZS05OThiLWVlNTM5ZTcyYjljMw==',
  );
});

test('injectThoughtSignature: 未知模型返回 undefined（不注入）', () => {
  assert.equal(injectThoughtSignature('gemini-3.6-flash'), undefined);
  assert.equal(injectThoughtSignature(''), undefined);
  assert.equal(injectThoughtSignature(undefined), undefined);
});

test('cleanMessages: 缺失 sig 时自动注入模型级固定 sig（gemma-4-26b）', () => {
  // ⚠️ 根治方案：客户端合并流式 tool_calls 时可能丢失 sig → 下一轮 Google 报 400
  //    "Function call is missing a thought_signature"。代理在请求侧自动注入即可根治。
  const messages = [
    { role: 'assistant', content: null, tool_calls: [{
      id: 'call_1', type: 'function',
      function: { name: 'default_api:use_capability', arguments: '{"action":"list"}' },
    }] },
  ];
  const out = cleanMessages(messages, 'gemma-4-26b-a4b-it');
  assert.equal(
    out[0].tool_calls[0].extra_content.google.thought_signature,
    'EiYKJGUyNDgzMGE3LTVjZDYtNDJmZS05OThiLWVlNTM5ZTcyYjljMw==',
    '缺失 sig 时自动注入模型级固定 sig',
  );
  assert.equal(out[0].tool_calls[0].thought_signature, 'EiYKJGUyNDgzMGE3LTVjZDYtNDJmZS05OThiLWVlNTM5ZTcyYjljMw==');
});

test('cleanMessages: 已有 sig 时优先使用已有值，不覆盖', () => {
  const messages = [
    { role: 'assistant', content: null, tool_calls: [{
      id: 'call_1', type: 'function',
      function: { name: 'default_api:use_capability', arguments: '{"action":"list"}' },
      thought_signature: 'client_provided_sig',
    }] },
  ];
  const out = cleanMessages(messages, 'gemma-4-26b-a4b-it');
  assert.equal(out[0].tool_calls[0].extra_content.google.thought_signature, 'client_provided_sig', '已有 sig 不应被覆盖');
});

test('cleanMessages: 无固定 sig 的模型不注入', () => {
  const messages = [
    { role: 'assistant', content: null, tool_calls: [{
      id: 'call_1', type: 'function',
      function: { name: 'bash', arguments: '{"cmd":"ls"}' },
    }] },
  ];
  const out = cleanMessages(messages, 'gemini-3.6-flash');
  assert.equal(out[0].tool_calls[0].extra_content, undefined, '无固定 sig 的模型不应注入');
});

test('sanitizeOpenAIBody: 传入 model 时自动注入固定 sig', () => {
  const body = JSON.stringify({
    model: 'gemma-4-26b-a4b-it',
    messages: [
      { role: 'user', content: 'run' },
      { role: 'assistant', content: null, tool_calls: [{
        id: 'call_1', type: 'function',
        function: { name: 'default_api:bash', arguments: '{"cmd":"echo hi"}' },
      }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'hi' },
    ],
  });
  const out = JSON.parse(sanitizeOpenAIBody(body));
  assert.equal(
    out.messages[1].tool_calls[0].extra_content.google.thought_signature,
    'EiYKJGUyNDgzMGE3LTVjZDYtNDJmZS05OThiLWVlNTM5ZTcyYjljMw==',
    'sanitizeOpenAIBody 应把 model 传入 cleanMessages 实现自动注入',
  );
});
