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
