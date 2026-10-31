// tests/chat-stream.test.mjs
//
// 流式转换共享实现的回归测试（lib/chat-stream.js）。
//
// ⚠️ 这份实现原先在 Vercel 端与 CF Worker 端各有一份，且行为不一致：
//    · Vercel 端没有跨事件 <thought> 状态机
//    · Vercel 端的非流式→SSE 拆分缺 tool_calls 分支（工具调用直接丢失）
//    · Vercel 端不识别 <|thought>
//    现在两端共用同一份实现，这里把关键行为钉死，避免再次分叉。
//
// 运行：npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isQclawCompatClient,
  createThoughtStripper,
  buildChatCompletionChunks,
  buildSseError,
  transformUpstreamSSE,
  SSE_DONE,
} from '../lib/chat-stream.js';

/** 把 SSE chunk 数组解析成 [{ delta, finish_reason }] */
function parseChunks(chunks) {
  return chunks.map(c => {
    assert.ok(c.startsWith('data: '), `chunk 应以 'data: ' 开头: ${c.slice(0, 40)}`);
    return JSON.parse(c.slice(6)).choices[0];
  });
}

test('isQclawCompatClient: 识别 QClaw / WorkBuddy', () => {
  assert.equal(isQclawCompatClient('QClaw/1.2.3'), true);
  assert.equal(isQclawCompatClient('workbuddy-agent'), true);
  assert.equal(isQclawCompatClient('Mozilla/5.0 (Macintosh) QClaw'), true);
});

test('isQclawCompatClient: 普通客户端与空 UA 不触发兼容模式', () => {
  assert.equal(isQclawCompatClient('curl/8.4.0'), false);
  assert.equal(isQclawCompatClient('openai-node/4.0'), false);
  assert.equal(isQclawCompatClient(''), false);
  assert.equal(isQclawCompatClient(undefined), false);
  assert.equal(isQclawCompatClient(null), false);
});

test('createThoughtStripper: 同一 delta 内闭合的 <thought>', () => {
  const s = createThoughtStripper();
  const r = s.strip('a<thought>思考中</thought>b');
  assert.equal(r.content, 'ab');
  assert.equal(r.reasoning, '思考中');
});

test('createThoughtStripper: 跨 delta 的 <thought>（状态机核心）', () => {
  const s = createThoughtStripper();
  // 第一个 delta 只有开始标签
  const r1 = s.strip('前缀<thought>思考');
  assert.equal(r1.content, '前缀');
  assert.equal(r1.reasoning, '');
  assert.equal(s.inThought, true);

  // 第二个 delta 才闭合
  const r2 = s.strip('还在想</thought>后续正文');
  assert.equal(r2.content, '后续正文');
  assert.equal(r2.reasoning, '思考还在想');
  assert.equal(s.inThought, false);
});

test('createThoughtStripper: 支持 <|thought> 变体', () => {
  const s = createThoughtStripper();
  const r1 = s.strip('<|thought>推理');
  assert.equal(r1.reasoning, '');
  assert.equal(s.inThought, true);
  const r2 = s.strip('结束<|/thought>答案');
  assert.equal(r2.reasoning, '推理结束');
  assert.equal(r2.content, '答案');
});

test('createThoughtStripper: 流结束时 flush 未闭合的思考内容', () => {
  const s = createThoughtStripper();
  s.strip('<thought>没闭合的思考');
  assert.equal(s.inThought, true);
  assert.equal(s.flush(), '没闭合的思考');
  assert.equal(s.flush(), '');
  assert.equal(s.inThought, false);
});

test('buildChatCompletionChunks: 顺序为 reasoning → content → tool_calls → finish_reason', () => {
  const chunks = buildChatCompletionChunks({
    id: 'chatcmpl-1',
    created: 100,
    model: 'gemini-3.5-flash-lite',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        content: '好的，我来调用工具',
        reasoning_content: '先思考一下',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
        }],
      },
    }],
  });
  const parsed = parseChunks(chunks);
  const deltas = parsed.map(c => c.delta);

  assert.equal(deltas[0].reasoning_content, '先思考一下');
  assert.ok(deltas.some(d => d.content === '好的，我来调用工具'));
  assert.ok(deltas.some(d => d.tool_calls), 'tool_calls 必须出现在 SSE 中');

  // tool_calls 的 name 与 arguments 都要有
  const tcDelta = deltas.find(d => d.tool_calls);
  assert.equal(tcDelta.tool_calls[0].id, 'call_1');
  assert.equal(tcDelta.tool_calls[0].function.name, 'read_file');
  const argDelta = deltas.find(d => d.tool_calls && d.tool_calls[0].function.arguments);
  assert.equal(argDelta.tool_calls[0].function.arguments, '{"path":"a.txt"}');

  // 最后一个 chunk 带 finish_reason
  assert.equal(parsed[parsed.length - 1].finish_reason, 'tool_calls');
});

test('buildChatCompletionChunks: content 中的 <thought> 被迁移到 reasoning_content', () => {
  const chunks = buildChatCompletionChunks({
    id: 'x', created: 1, model: 'm',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { content: '<thought>内部思考</thought>最终答案' },
    }],
  });
  const deltas = parseChunks(chunks).map(c => c.delta);
  const reasoning = deltas.filter(d => d.reasoning_content).map(d => d.reasoning_content).join('');
  const content = deltas.filter(d => d.content).map(d => d.content).join('');
  assert.equal(reasoning, '内部思考');
  assert.equal(content, '最终答案');
  assert.ok(!content.includes('<thought>'), '正文不应残留 thought 标签');
});

test('buildChatCompletionChunks: 无内容时也发 finish_reason（避免 empty stream）', () => {
  const chunks = buildChatCompletionChunks({
    id: 'x', created: 1, model: 'm',
    choices: [{ index: 0, finish_reason: 'stop', message: {} }],
  });
  const parsed = parseChunks(chunks);
  assert.equal(parsed[parsed.length - 1].finish_reason, 'stop');
});

test('buildChatCompletionChunks: 透传 tool_calls 的 thought_signature（Google thinking 模型）', () => {
  const chunks = buildChatCompletionChunks({
    id: 'chatcmpl-1',
    created: 100,
    model: 'gemini-4-thinking',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        content: '',
        reasoning_content: '思考中...',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'bash', arguments: '{"cmd":"ls"}' },
          thought_signature: 'abc123signature'
        }],
      },
    }],
  });
  const parsed = parseChunks(chunks);
  const deltas = parsed.map(c => c.delta);

  // 验证第一个 tool_calls chunk 包含 thought_signature
  const tcDelta = deltas.find(d => d.tool_calls);
  assert.ok(tcDelta, 'tool_calls 必须出现在 SSE 中');
  assert.equal(tcDelta.tool_calls[0].thought_signature, 'abc123signature', 'thought_signature 必须透传');
  assert.equal(tcDelta.tool_calls[0].id, 'call_1');
  assert.equal(tcDelta.tool_calls[0].function.name, 'bash');
});

test('buildSseError: 错误被包装成 SSE data 帧', () => {
  const sse = buildSseError(503, 'upstream down', 'req-1');
  assert.ok(sse.startsWith('data: '));
  const payload = JSON.parse(sse.slice(6).trim());
  assert.equal(payload.error.code, 503);
  assert.equal(payload.error.reqId, 'req-1');
  assert.ok(payload.error.message.includes('upstream down'));
});

test('SSE_DONE: 结束标记格式正确', () => {
  assert.equal(SSE_DONE, 'data: [DONE]\n\n');
});

test('transformUpstreamSSE: 剥离跨事件 <thought> 并迁移到 reasoning_content', async () => {
  const sseLines = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'A<thought>思考' } }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '继续</thought>B' } }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    '',
  ].join('\n');

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseLines));
      controller.close();
    },
  });

  const out = [];
  for await (const piece of transformUpstreamSSE(body, { reqId: 'r' })) out.push(piece);
  const text = out.join('');

  const reasoning = [...text.matchAll(/"reasoning_content":"([^"]*)"/g)].map(m => m[1]).join('');
  assert.equal(reasoning, '思考继续');
  assert.ok(!/"content":"[^"]*<thought>/.test(text), '正文不应含 thought 标签');
  assert.ok(text.includes('"finish_reason":"stop"'), '应保留上游的 finish_reason');
});

test('transformUpstreamSSE: 上游未给 finish_reason 时补一条（避免 empty stream）', async () => {
  const sseLines = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n';
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseLines));
      controller.close();
    },
  });

  const out = [];
  for await (const piece of transformUpstreamSSE(body, { reqId: 'r' })) out.push(piece);
  const text = out.join('');
  assert.ok(text.includes('"finish_reason":"stop"'), '应补齐 finish_reason');
});

test('transformUpstreamSSE: 流结束时有未闭合的 thought → flush 为 reasoning_content', async () => {
  const sseLines = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'x<thought>未闭合' } }] }) + '\n';
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseLines));
      controller.close();
    },
  });

  const out = [];
  for await (const piece of transformUpstreamSSE(body, { reqId: 'r' })) out.push(piece);
  const text = out.join('');
  assert.ok(text.includes('未闭合'), '未闭合的思考内容应被 flush 出来');
  assert.ok(!text.includes('<thought>'), '不应残留未解析的标签');
});
