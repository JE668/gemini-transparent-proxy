// tests/upstream-retry.test.mjs
//
// lib/upstream-retry.js 的行为约束测试。
//
// 这个模块决定「上游限流/临时故障时，代理是硬失败还是自愈」，
// 因此每条分支都必须有断言 —— 任何一条回归都会让 Codex 在配额墙上直接崩掉。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isRetryableStatus,
  parseRetryAfterSeconds,
  isHighDemand503,
  fetchWithModelFallback,
  RETRYABLE_STATUSES,
} from '../lib/upstream-retry.js';
import { MODEL_FALLBACKS } from '../lib/model-fallbacks.js';

// ── 工具 ──

function makeResponse(status, body = '', headers = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** 记录每次请求的 body，并按脚本返回预设响应 */
function makeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error('fetchFn 被调用次数超出预期');
    return typeof next === 'function' ? next() : next;
  };
  fn.calls = calls;
  return fn;
}

function makeSleep() {
  const delays = [];
  const fn = async (ms) => { delays.push(ms); };
  fn.delays = delays;
  return fn;
}

const BASE_BODY = { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] };
const FALLBACK = { 'gemini-3.8-flash': 'gemini-3.5-flash-lite' };

// ── 状态码判定 ──

test('isRetryableStatus：只把 429/500/503/524 当作可重试', () => {
  assert.deepEqual([...RETRYABLE_STATUSES].sort(), [429, 500, 503, 524]);
  for (const s of [429, 500, 503, 524]) assert.equal(isRetryableStatus(s), true, `${s} 应可重试`);
  for (const s of [200, 201, 400, 401, 404, 422, 502, 505, 528]) {
    assert.equal(isRetryableStatus(s), false, `${s} 不应可重试`);
  }
});

test('isRetryableStatus：接受字符串形式的状态码', () => {
  assert.equal(isRetryableStatus('429'), true);
  assert.equal(isRetryableStatus('200'), false);
});

// ── Retry-After 解析 ──

test('parseRetryAfterSeconds：优先用上游 Retry-After', () => {
  const r = makeResponse(429, '', { 'Retry-After': '3' });
  assert.equal(parseRetryAfterSeconds(r), 3);
});

test('parseRetryAfterSeconds：封顶 10 秒（避免长时间挂死）', () => {
  const r = makeResponse(429, '', { 'Retry-After': '600' });
  assert.equal(parseRetryAfterSeconds(r), 10);
});

test('parseRetryAfterSeconds：缺失 / 非法时退回默认 5 秒', () => {
  assert.equal(parseRetryAfterSeconds(makeResponse(429)), 5);
  assert.equal(parseRetryAfterSeconds(makeResponse(429, '', { 'Retry-After': 'abc' })), 5);
  assert.equal(parseRetryAfterSeconds(makeResponse(429, '', { 'Retry-After': '0' })), 5);
});

test('parseRetryAfterSeconds：非法响应对象不抛错', () => {
  assert.equal(parseRetryAfterSeconds(null), 5);
  assert.equal(parseRetryAfterSeconds({}), 5);
  assert.equal(parseRetryAfterSeconds({ headers: {} }), 5);
});

// ── 503 高负载文案判定 ──

test('isHighDemand503：识别容量不足文案', () => {
  assert.equal(isHighDemand503('RESOURCE_EXHAUSTED: UNAVAILABLE'), true);
  assert.equal(isHighDemand503('The model is under high demand'), true);
});

test('isHighDemand503：空值 / 非字符串 / 无关文案一律 false（不抛错）', () => {
  assert.equal(isHighDemand503(null), false);
  assert.equal(isHighDemand503(undefined), false);
  assert.equal(isHighDemand503(''), false);
  assert.equal(isHighDemand503(123), false);
  assert.equal(isHighDemand503({}), false);
  assert.equal(isHighDemand503('PERMISSION_DENIED'), false);
});

// ── fetchWithModelFallback ──

test('成功响应：直接返回，不重试也不降级', async () => {
  const fetchFn = makeFetch([makeResponse(200, '{"ok":true}')]);
  const sleep = makeSleep();
  const res = await fetchWithModelFallback({
    fetchFn, url: 'https://x', headers: {}, body: BASE_BODY,
    modelId: BASE_BODY.model, fallbacks: FALLBACK, sleep,
  });
  assert.equal(res.response.status, 200);
  assert.equal(res.modelId, 'gemini-3.8-flash');
  assert.equal(res.fellBack, false);
  assert.equal(res.retries, 0);
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(sleep.delays.length, 0);
});

test('非可重试的失败（如 400）：原样返回，不消耗重试预算', async () => {
  const fetchFn = makeFetch([makeResponse(400, '{"error":"bad"}')]);
  const res = await fetchWithModelFallback({
    fetchFn, url: 'https://x', headers: {}, body: BASE_BODY,
    modelId: BASE_BODY.model, fallbacks: FALLBACK, sleep: makeSleep(),
  });
  assert.equal(res.response.status, 400);
  assert.equal(res.fellBack, false);
  assert.equal(fetchFn.calls.length, 1);
});

test('429：按 Retry-After 退避后同模型重试，成功即返回（模型不变）', async () => {
  const fetchFn = makeFetch([
    makeResponse(429, '{"error":"quota"}', { 'Retry-After': '2' }),
    makeResponse(200, '{"ok":true}'),
  ]);
  const sleep = makeSleep();
  const res = await fetchWithModelFallback({
    fetchFn, url: 'https://x', headers: {}, body: BASE_BODY,
    modelId: BASE_BODY.model, fallbacks: FALLBACK, sleep,
  });
  assert.equal(res.response.status, 200);
  assert.equal(res.modelId, 'gemini-3.8-flash');
  assert.equal(res.fellBack, false);
  assert.equal(res.retries, 1);
  assert.equal(fetchFn.calls.length, 2);
  assert.deepEqual(sleep.delays, [2000], '应按 Retry-After=2 秒退避');
  assert.equal(fetchFn.calls[0].body.model, 'gemini-3.8-flash');
  assert.equal(fetchFn.calls[1].body.model, 'gemini-3.8-flash', '同模型重试不得换模型');
});

test('429 重试仍失败：降级到备用模型并使用其响应', async () => {
  const fetchFn = makeFetch([
    makeResponse(429, '{"error":"quota"}', { 'Retry-After': '1' }),
    makeResponse(429, '{"error":"quota"}', { 'Retry-After': '1' }),
    makeResponse(200, '{"ok":true}'),
  ]);
  const res = await fetchWithModelFallback({
    fetchFn, url: 'https://x', headers: {}, body: BASE_BODY,
    modelId: BASE_BODY.model, fallbacks: FALLBACK, sleep: makeSleep(),
  });
  assert.equal(res.response.status, 200);
  assert.equal(res.modelId, 'gemini-3.5-flash-lite');
  assert.equal(res.fellBack, true);
  assert.equal(res.retries, 2);
  assert.equal(fetchFn.calls.length, 3);
  assert.equal(fetchFn.calls[2].body.model, 'gemini-3.5-flash-lite', '第三次请求应使用降级模型');
});

test('500：跳过 429 退避，直接降级', async () => {
  const fetchFn = makeFetch([
    makeResponse(500, 'boom'),
    makeResponse(200, '{"ok":true}'),
  ]);
  const sleep = makeSleep();
  const res = await fetchWithModelFallback({
    fetchFn, url: 'https://x', headers: {}, body: BASE_BODY,
    modelId: BASE_BODY.model, fallbacks: FALLBACK, sleep,
  });
  assert.equal(res.fellBack, true);
  assert.equal(res.modelId, 'gemini-3.5-flash-lite');
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(sleep.delays.length, 0, '500 不应触发 429 退避');
});

test('524：直接降级', async () => {
  const fetchFn = makeFetch([makeResponse(524, 'timeout'), makeResponse(200, '{}')]);
  const res = await fetchWithModelFallback({
    fetchFn, url: 'https://x', headers: {}, body: BASE_BODY,
    modelId: BASE_BODY.model, fallbacks: FALLBACK, sleep: makeSleep(),
  });
  assert.equal(res.fellBack, true);
  assert.equal(fetchFn.calls.length, 2);
});

test('503 且非容量不足：原样返回 503，不降级（不浪费备用额度）', async () => {
  const fetchFn = makeFetch([makeResponse(503, 'PERMISSION_DENIED')]);
  const res = await fetchWithModelFallback({
    fetchFn, url: 'https://x', headers: {}, body: BASE_BODY,
    modelId: BASE_BODY.model, fallbacks: FALLBACK, sleep: makeSleep(),
  });
  assert.equal(res.response.status, 503);
  assert.equal(res.fellBack, false);
  assert.equal(fetchFn.calls.length, 1);
});

test('503 且是容量不足：降级', async () => {
  const fetchFn = makeFetch([
    makeResponse(503, 'RESOURCE_EXHAUSTED: UNAVAILABLE'),
    makeResponse(200, '{}'),
  ]);
  const res = await fetchWithModelFallback({
    fetchFn, url: 'https://x', headers: {}, body: BASE_BODY,
    modelId: BASE_BODY.model, fallbacks: FALLBACK, sleep: makeSleep(),
  });
  assert.equal(res.fellBack, true);
  assert.equal(fetchFn.calls.length, 2);
});

test('降级请求保留原请求体的其它字段，只替换 model', async () => {
  const body = {
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.3,
    tools: [{ type: 'function', function: { name: 'f' } }],
  };
  const fetchFn = makeFetch([makeResponse(500, 'x'), makeResponse(200, '{}')]);
  await fetchWithModelFallback({
    fetchFn, url: 'https://x', headers: {}, body,
    modelId: body.model, fallbacks: FALLBACK, sleep: makeSleep(),
  });
  const sent = fetchFn.calls[1].body;
  assert.equal(sent.model, 'gemini-3.5-flash-lite');
  assert.deepEqual(sent.messages, body.messages);
  assert.equal(sent.temperature, 0.3);
  assert.deepEqual(sent.tools, body.tools);
});

test('模型没有配置降级目标时：原样返回失败，不额外请求', async () => {
  const fetchFn = makeFetch([makeResponse(500, 'boom')]);
  const res = await fetchWithModelFallback({
    fetchFn, url: 'https://x', headers: {}, body: BASE_BODY,
    modelId: 'unknown-model', fallbacks: FALLBACK, sleep: makeSleep(),
  });
  assert.equal(res.response.status, 500);
  assert.equal(res.fellBack, false);
  assert.equal(fetchFn.calls.length, 1);
});

test('降级目标是自己时不做自我降级', async () => {
  const fetchFn = makeFetch([makeResponse(500, 'boom')]);
  const res = await fetchWithModelFallback({
    fetchFn, url: 'https://x', headers: {}, body: BASE_BODY,
    modelId: 'gemini-2.5-flash-lite',
    fallbacks: { 'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite' },
    sleep: makeSleep(),
  });
  assert.equal(res.fellBack, false);
  assert.equal(fetchFn.calls.length, 1);
});

test('降级也失败时：返回原始那次失败的响应（保留原状态码）', async () => {
  const fetchFn = makeFetch([
    makeResponse(500, '原始错误'),
    makeResponse(503, '降级后的错误'),
  ]);
  const res = await fetchWithModelFallback({
    fetchFn, url: 'https://x', headers: {}, body: BASE_BODY,
    modelId: BASE_BODY.model, fallbacks: FALLBACK, sleep: makeSleep(),
  });
  assert.equal(res.response.status, 500, '应返回原始失败的状态码');
  assert.equal(res.fellBack, false);
  assert.equal(await res.response.text(), '原始错误', '应保留原始错误体');
});

test('429 重试仍失败且降级也失败：返回「最初那次」429（而非重试后的 429）', async () => {
  const fetchFn = makeFetch([
    makeResponse(429, '{"error":"第一次429"}', { 'Retry-After': '2' }),
    makeResponse(429, '{"error":"重试后的429"}', { 'Retry-After': '30' }),
    makeResponse(429, '{"error":"降级后的429"}', { 'Retry-After': '60' }),
  ]);
  const res = await fetchWithModelFallback({
    fetchFn, url: 'https://x', headers: {}, body: BASE_BODY,
    modelId: BASE_BODY.model, fallbacks: FALLBACK, sleep: makeSleep(),
  });
  assert.equal(res.response.status, 429);
  assert.equal(res.fellBack, false);
  assert.equal(res.retries, 2, '应记录 1 次同模型重试 + 1 次降级尝试');
  assert.equal(fetchFn.calls.length, 3);
  const body = await res.response.text();
  assert.equal(body, '{"error":"第一次429"}', '应返回最初那次 429 的错误体，而非重试后的');
  assert.equal(res.response.headers.get('Retry-After'), '2', '应保留最初那次 429 的 Retry-After');
});

test('onFallback / onRetry 回调会被调用，便于服务端记录降级事实', async () => {
  const events = [];
  const fetchFn = makeFetch([
    makeResponse(429, '', { 'Retry-After': '3' }),
    makeResponse(429, ''),
    makeResponse(200, '{}'),
  ]);
  await fetchWithModelFallback({
    fetchFn, url: 'https://x', headers: {}, body: BASE_BODY,
    modelId: BASE_BODY.model, fallbacks: FALLBACK, sleep: makeSleep(),
    onRetry: (status, delaySec) => events.push(['retry', status, delaySec]),
    onFallback: (from, to, status) => events.push(['fallback', from, to, status]),
  });
  assert.deepEqual(events, [
    ['retry', 429, 3],
    ['fallback', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 200],
  ]);
});

test('默认降级表来自 lib/model-fallbacks.js（不传 fallbacks 也能降级）', async () => {
  const fetchFn = makeFetch([makeResponse(500, 'x'), makeResponse(200, '{}')]);
  const res = await fetchWithModelFallback({
    fetchFn, url: 'https://x', headers: {}, body: BASE_BODY,
    modelId: 'gemini-3.8-flash', sleep: makeSleep(),
  });
  assert.equal(res.fellBack, true);
  assert.equal(res.modelId, MODEL_FALLBACKS['gemini-3.8-flash']);
});
