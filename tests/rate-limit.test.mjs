// tests/rate-limit.test.js
//
// 限流模块的回归测试。
//
// lib/rate-limit.js 不直接 import @upstash/redis（Redis 客户端由调用方注入），
// 因此这里用一个内存版「假 Redis」模拟 eval 脚本的语义，
// 验证 JS 侧的契约：key 命名、参数顺序、返回值解析、Retry-After 计算、失败开放。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRpmLimit,
  computeClientFingerprint,
  checkRpmLimit,
  checkTpmLimit,
  RATE_LIMIT_WINDOW_MS,
} from '../lib/rate-limit.js';

/**
 * 假 Redis：识别脚本特征并模拟对应滑动窗口语义。
 *  - 含 'ZCARD'            → RPM 脚本
 *  - 含 'cost' 且 'ZRANGEBYSCORE' → TPM 脚本
 */
class FakeRedis {
  constructor({ now = 1_000_000 } = {}) {
    this.now = now;
    this.zsets = new Map();   // key -> [{ score, member }]
    this.calls = [];          // 记录调用参数，便于断言 key 命名
  }

  _bucket(key) {
    if (!this.zsets.has(key)) this.zsets.set(key, []);
    return this.zsets.get(key);
  }

  async eval(script, keys, args) {
    this.calls.push({ script, keys, args });
    const key = keys[0];
    const now = Number(args[0]);
    const window = Number(args[1]);

    if (script.includes('ZCARD')) {
      // ── RPM ──
      const limit = Number(args[2]);
      const member = args[3];
      const arr = this._bucket(key).filter(e => e.score > now - window);
      this.zsets.set(key, arr);
      if (arr.length >= limit) {
        const oldest = arr[0];
        return [1, String(oldest.score)];
      }
      arr.push({ score: now, member });
      return [0, String(arr.length)];
    }

    // ── TPM ──
    const limit = Number(args[2]);
    const cost = Number(args[3]);
    const arr = this._bucket(key).filter(e => e.score > now - window);
    this.zsets.set(key, arr);
    const sum = arr.reduce((s, e) => s + Number(String(e.member).split(':')[0]), 0);
    if (sum + cost > limit) {
      const oldest = arr[0];
      const retryAfter = Math.ceil((oldest.score + window - now) / 1000);
      return [0, String(sum), String(retryAfter)];
    }
    arr.push({ score: now, member: `${cost}:${now}:r` });
    return [1, String(sum + cost), '0'];
  }
}

const NOW = 1_000_000;

test('parseRpmLimit: 默认 60，非法值视为不限流', () => {
  assert.equal(parseRpmLimit(undefined), 60);
  assert.equal(parseRpmLimit(''), 60);
  assert.equal(parseRpmLimit('30'), 30);
  assert.equal(parseRpmLimit('0'), 0);
  assert.equal(parseRpmLimit('-1'), 0);
  assert.equal(parseRpmLimit('abc'), 0);
});

test('computeClientFingerprint: 稳定、8 位十六进制、同 key 相同', async () => {
  const a = await computeClientFingerprint('sk-test-key');
  const b = await computeClientFingerprint('sk-test-key');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}$/);
  const c = await computeClientFingerprint('sk-other-key');
  assert.notEqual(a, c);
});

test('checkRpmLimit: 无 Redis / anon / limit=0 一律放行', async () => {
  assert.equal((await checkRpmLimit({ redis: null, fingerprint: 'fp', rpmLimit: 15 })).rejected, false);
  assert.equal((await checkRpmLimit({ redis: new FakeRedis(), fingerprint: 'anon', rpmLimit: 15 })).rejected, false);
  assert.equal((await checkRpmLimit({ redis: new FakeRedis(), fingerprint: 'fp', rpmLimit: 0 })).rejected, false);
});

test('checkRpmLimit: 超过阈值被拒绝且给出 Retry-After', async () => {
  const redis = new FakeRedis({ now: NOW });
  const first = await checkRpmLimit({ redis, fingerprint: 'fp', rpmLimit: 2, nowMs: NOW });
  assert.equal(first.rejected, false);
  const second = await checkRpmLimit({ redis, fingerprint: 'fp', rpmLimit: 2, nowMs: NOW + 1000 });
  assert.equal(second.rejected, false);
  const third = await checkRpmLimit({ redis, fingerprint: 'fp', rpmLimit: 2, nowMs: NOW + 2000 });
  assert.equal(third.rejected, true);
  assert.ok(third.retryAfter > 0, '被拒绝时必须给出正数 Retry-After');
});

test('checkRpmLimit: Redis 异常时失败开放（不得中断服务）', async () => {
  const broken = { eval: async () => { throw new Error('redis down'); } };
  const r = await checkRpmLimit({ redis: broken, fingerprint: 'fp', rpmLimit: 1, nowMs: NOW });
  assert.equal(r.rejected, false, '限流器故障必须放行');
});

test('checkRpmLimit: key 命名沿用 ratelimit:<fingerprint>', async () => {
  const redis = new FakeRedis({ now: NOW });
  await checkRpmLimit({ redis, fingerprint: 'abcdef12', rpmLimit: 5, nowMs: NOW });
  assert.equal(redis.calls[0].keys[0], 'ratelimit:abcdef12');
});

test('checkTpmLimit: 未知模型不受限且 inputTokens 记 0', async () => {
  const redis = new FakeRedis({ now: NOW });
  const r = await checkTpmLimit({
    redis, fingerprint: 'fp', modelId: 'no-such-model',
    body: { messages: [{ role: 'user', content: 'abcdefgh' }] }, nowMs: NOW,
  });
  assert.equal(r.rejected, false);
  assert.equal(r.inputTokens, 0, '未进入限流判定时 inputTokens 保持 0（与遥测口径一致）');
  assert.equal(redis.calls.length, 0, '未知模型不应发起 Redis 调用');
});

test('checkTpmLimit: 估算输入 token 并计入滑动窗口', async () => {
  const redis = new FakeRedis({ now: NOW });
  const body = { messages: [{ role: 'user', content: 'a'.repeat(400) }] }; // ~104 token
  const r1 = await checkTpmLimit({
    redis, fingerprint: 'fp', modelId: 'gemma-4-31b-it', body, nowMs: NOW,
  });
  assert.equal(r1.rejected, false);
  assert.equal(r1.inputTokens, 4 + 100);
  assert.equal(r1.limit, 16000);
  assert.equal(redis.calls[0].keys[0], 'tpm:gemma-4-31b-it:fp');
});

test('checkTpmLimit: 超出 TPM 被拒绝且给出 Retry-After', async () => {
  const redis = new FakeRedis({ now: NOW });
  // gemma-4-31b-it 上限 16000：连续灌入必然撞墙
  const body = { messages: [{ role: 'user', content: 'a'.repeat(60000) }] }; // ~15004 token
  let rejected = null;
  for (let i = 0; i < 5; i++) {
    const r = await checkTpmLimit({
      redis, fingerprint: 'fp', modelId: 'gemma-4-31b-it', body, nowMs: NOW + i,
    });
    if (r.rejected) { rejected = r; break; }
  }
  assert.ok(rejected, '持续灌入必须触发 TPM 拒绝');
  assert.ok(rejected.retryAfter > 0);
  assert.equal(rejected.limit, 16000);
});

test('checkTpmLimit: 非 OpenAI 兼容端点不限流', async () => {
  const redis = new FakeRedis({ now: NOW });
  const r = await checkTpmLimit({
    redis, fingerprint: 'fp', modelId: 'gemma-4-31b-it',
    body: { messages: [{ role: 'user', content: 'a'.repeat(100000) }] },
    openAICompat: false, nowMs: NOW,
  });
  assert.equal(r.rejected, false);
  assert.equal(redis.calls.length, 0);
});

test('checkTpmLimit: Redis 异常时失败开放', async () => {
  const broken = { eval: async () => { throw new Error('redis down'); } };
  const r = await checkTpmLimit({
    redis: broken, fingerprint: 'fp', modelId: 'gemma-4-31b-it',
    body: { messages: [{ role: 'user', content: 'x' }] }, nowMs: NOW,
  });
  assert.equal(r.rejected, false);
});

test('限流窗口为 60 秒', () => {
  assert.equal(RATE_LIMIT_WINDOW_MS, 60 * 1000);
});
