// tests/telemetry.test.mjs
//
// 共享遥测模块的回归测试。
//
// ⚠️ 背景：
//   1. Dashboard 的「平均延迟」读 `latencySum:{date}:{model}` + `latencyCount:{date}:{model}`，
//      「客户端」面板读 `clients:{date}:keys` + `clients:{date}:{fp}` + `client:info:{fp}`，
//      但旧代码里**没有任何写入方** → 这些面板恒为空。
//   2. 代理侧限流（RPM / TPM）直接 return 429，不写遥测 →
//      Dashboard 的请求总量 / 错误率看不到「被代理拦掉」的请求。
//
// 本测试钉住：键名、口径、以及两端（Vercel / CF Worker）的命令翻译一致性。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTelemetryEvents,
  buildRateLimitTelemetryEvents,
  telemetryEventsToRedisPromises,
  telemetryEventsToUpstashCommands,
  TELEMETRY_OPS,
} from '../lib/telemetry.js';

const BASE = {
  date: '2026-10-30',
  hour: 9,
  status: 200,
  model: 'gemini-3.8-flash',
  latency: 1234,
  ua: 'curl/8.0',
  ip: '1.2.3.4',
};

/** 取出某个 key 对应的事件 */
function eventsFor(events, key) {
  return events.filter(e => e.key === key);
}

/** 取出 op + key 组合 */
function findEvent(events, op, key) {
  return events.find(e => e.op === op && e.key === key);
}

test('buildTelemetryEvents: 总是写 status 与 timeline', () => {
  const events = buildTelemetryEvents(BASE);
  assert.ok(findEvent(events, TELEMETRY_OPS.INCR, 'status:2026-10-30:200'));
  assert.ok(findEvent(events, TELEMETRY_OPS.INCR, 'timeline:2026-10-30:h9'));
});

test('buildTelemetryEvents: 成功请求写配额，失败请求不写配额', () => {
  const ok = buildTelemetryEvents(BASE);
  assert.ok(findEvent(ok, TELEMETRY_OPS.INCR, 'quota:2026-10-30:gemini-3.8-flash'));
  assert.ok(findEvent(ok, TELEMETRY_OPS.INCR, 'quota:global:2026-10-30'));

  const bad = buildTelemetryEvents({ ...BASE, status: 500 });
  assert.equal(findEvent(bad, TELEMETRY_OPS.INCR, 'quota:global:2026-10-30'), undefined);
  // 失败必须进错误日志
  assert.ok(findEvent(bad, TELEMETRY_OPS.LPUSH, 'errors:2026-10-30'));
});

test('buildTelemetryEvents: 写平均延迟计数器（补齐 Dashboard 空面板）', () => {
  const events = buildTelemetryEvents(BASE);
  const sum = findEvent(events, TELEMETRY_OPS.INCRBY, 'latencySum:2026-10-30:gemini-3.8-flash');
  const count = findEvent(events, TELEMETRY_OPS.INCR, 'latencyCount:2026-10-30:gemini-3.8-flash');
  assert.ok(sum, '必须写 latencySum');
  assert.equal(sum.args[0], 1234);
  assert.ok(count, '必须写 latencyCount');
});

test('buildTelemetryEvents: 写客户端维度 key（补齐客户端面板）', () => {
  const events = buildTelemetryEvents({ ...BASE, fingerprint: 'a1b2c3d4' });
  const keys = findEvent(events, TELEMETRY_OPS.SADD, 'clients:2026-10-30:keys');
  const count = findEvent(events, TELEMETRY_OPS.INCR, 'clients:2026-10-30:a1b2c3d4');
  const info = findEvent(events, TELEMETRY_OPS.HSET, 'client:info:a1b2c3d4');
  const expire = findEvent(events, TELEMETRY_OPS.EXPIRE, 'client:info:a1b2c3d4');
  assert.ok(keys);
  assert.equal(keys.args[0], 'a1b2c3d4');
  assert.ok(count);
  assert.ok(info);
  assert.equal(info.args[0].ua, 'curl/8.0');
  assert.ok(expire);
  assert.ok(expire.args[0] > 0);
});

test('buildTelemetryEvents: anon 指纹不写客户端维度（避免把所有人混成一档）', () => {
  const events = buildTelemetryEvents({ ...BASE, fingerprint: 'anon' });
  assert.equal(findEvent(events, TELEMETRY_OPS.SADD, 'clients:2026-10-30:keys'), undefined);
});

test('buildTelemetryEvents: 重试次数与慢请求', () => {
  const retried = buildTelemetryEvents({ ...BASE, totalRetries: 3 });
  const r = findEvent(retried, TELEMETRY_OPS.INCRBY, 'retries:2026-10-30');
  assert.ok(r);
  assert.equal(r.args[0], 3);

  const slow = buildTelemetryEvents({ ...BASE, latency: 20000 });
  assert.ok(findEvent(slow, TELEMETRY_OPS.ZADD, 'slow:2026-10-30'));

  const fast = buildTelemetryEvents({ ...BASE, latency: 100 });
  assert.equal(findEvent(fast, TELEMETRY_OPS.ZADD, 'slow:2026-10-30'), undefined);
});

test('buildTelemetryEvents: recent / errors 的条数上限正确', () => {
  const events = buildTelemetryEvents({ ...BASE, status: 500 });
  const recentTrim = findEvent(events, TELEMETRY_OPS.LTRIM, 'recent:2026-10-30');
  const errorsTrim = findEvent(events, TELEMETRY_OPS.LTRIM, 'errors:2026-10-30');
  assert.deepEqual(recentTrim.args, [0, 29]);
  assert.deepEqual(errorsTrim.args, [0, 19]);
});

test('buildRateLimitTelemetryEvents: 429 会写入 status / errors / timeline', () => {
  const events = buildRateLimitTelemetryEvents({
    date: '2026-10-30',
    hour: 9,
    model: 'gemini-3.8-flash',
    reason: 'rpm_limit_exceeded (15 RPM)',
  });
  assert.ok(findEvent(events, TELEMETRY_OPS.INCR, 'status:2026-10-30:429'));
  assert.ok(findEvent(events, TELEMETRY_OPS.INCR, 'timeline:2026-10-30:h9'));
  const errPush = findEvent(events, TELEMETRY_OPS.LPUSH, 'errors:2026-10-30');
  assert.ok(errPush);
  const entry = JSON.parse(errPush.args[0]);
  assert.equal(entry.status, 429);
  assert.match(entry.message, /rpm_limit_exceeded/);
  // 限流不是上游错误 → 不写配额
  assert.equal(findEvent(events, TELEMETRY_OPS.INCR, 'quota:global:2026-10-30'), undefined);
});

test('telemetryEventsToRedisPromises: 翻译成正确的 redis 方法调用', () => {
  const calls = [];
  const fakeRedis = new Proxy({}, {
    get(_t, prop) {
      return (...args) => {
        calls.push([prop, ...args]);
        return Promise.resolve(1);
      };
    },
  });

  const events = buildTelemetryEvents({ ...BASE, fingerprint: 'fp1', totalRetries: 2, latency: 20000 });
  const promises = telemetryEventsToRedisPromises(fakeRedis, events);

  assert.equal(promises.length, events.length);
  const methods = calls.map(c => c[0]);
  assert.ok(methods.includes('incr'));
  assert.ok(methods.includes('incrby'));
  assert.ok(methods.includes('lpush'));
  assert.ok(methods.includes('ltrim'));
  assert.ok(methods.includes('zadd'));
  assert.ok(methods.includes('sadd'));
  assert.ok(methods.includes('hset'));
  assert.ok(methods.includes('expire'));

  const zadd = calls.find(c => c[0] === 'zadd' && c[1] === 'slow:2026-10-30');
  assert.ok(zadd, '慢请求必须写 slow zset');
  assert.equal(zadd[2].score, 20000);
});

test('telemetryEventsToRedisPromises: redis 为 null 时返回空数组（不抛错）', () => {
  assert.deepEqual(telemetryEventsToRedisPromises(null, buildTelemetryEvents(BASE)), []);
  assert.deepEqual(telemetryEventsToRedisPromises({}, []), []);
});

test('telemetryEventsToUpstashCommands: 翻译成正确的 REST 命令数组', () => {
  const events = buildTelemetryEvents({ ...BASE, fingerprint: 'fp1', totalRetries: 2, latency: 20000 });
  const cmds = telemetryEventsToUpstashCommands(events);

  assert.equal(cmds.length, events.length);
  assert.ok(cmds.some(c => c[0] === 'INCR' && c[1] === 'status:2026-10-30:200'));
  assert.ok(cmds.some(c => c[0] === 'INCRBY' && c[1] === 'retries:2026-10-30' && c[2] === '2'));
  assert.ok(cmds.some(c => c[0] === 'SADD' && c[1] === 'clients:2026-10-30:keys' && c[2] === 'fp1'));
  assert.ok(cmds.some(c => c[0] === 'EXPIRE' && c[1] === 'client:info:fp1'));
  const hset = cmds.find(c => c[0] === 'HSET' && c[1] === 'client:info:fp1');
  assert.ok(hset);
  assert.ok(hset.includes('ua'));
  assert.ok(hset.includes('curl/8.0'));
  const zadd = cmds.find(c => c[0] === 'ZADD' && c[1] === 'slow:2026-10-30');
  assert.ok(zadd);
  assert.equal(zadd[2], '20000');
});

test('telemetryEventsToUpstashCommands: 空事件返回空数组', () => {
  assert.deepEqual(telemetryEventsToUpstashCommands([]), []);
  assert.deepEqual(telemetryEventsToUpstashCommands(null), []);
});

test('两端翻译产出的 key 集合完全一致（防止口径分叉）', () => {
  const events = buildTelemetryEvents({ ...BASE, fingerprint: 'fp1', totalRetries: 2, latency: 20000 });
  const redisKeys = events.map(e => `${e.op}:${e.key}`);
  const cmds = telemetryEventsToUpstashCommands(events);
  const cmdKeys = cmds.map(c => `${c[0]}:${c[1]}`);
  assert.equal(redisKeys.length, cmdKeys.length);
  // op 名称在两端是同一套（大小写归一后逐项对应）
  const normalized = redisKeys.map(s => s.split(':')[0]);
  const cmdOps = cmds.map(c => c[0]);
  for (let i = 0; i < normalized.length; i++) {
    assert.equal(normalized[i], cmdOps[i].toLowerCase());
  }
});

test('buildTelemetryEvents: 未知模型统一记为 unknown-model', () => {
  const events = buildTelemetryEvents({ ...BASE, model: '' });
  assert.ok(findEvent(events, TELEMETRY_OPS.INCR, 'quota:2026-10-30:unknown-model'));
});
