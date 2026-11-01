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
  LATENCY_BUCKETS,
  latencyToBucket,
  CLIENT_TYPES,
  TOKEN_BUCKETS,
  uaToClientType,
  tokensToBucket,
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

test('buildTelemetryEvents: 多维热力图写入小时×维度交叉计数', () => {
  const events = buildTelemetryEvents({ ...BASE, status: 429, latency: 1234 });
  // 状态×小时
  const statusHeat = findEvent(events, TELEMETRY_OPS.HINCRBY, 'heat:status:2026-10-30:h9');
  assert.ok(statusHeat, '必须写 status×hour 交叉计数');
  assert.deepEqual(statusHeat.args, ['429', 1]);
  // 延迟×小时：1234ms → mid 桶（0.5–2s）
  const latencyHeat = findEvent(events, TELEMETRY_OPS.HINCRBY, 'heat:latency:2026-10-30:h9');
  assert.ok(latencyHeat, '必须写 latency×hour 交叉计数');
  assert.deepEqual(latencyHeat.args, ['mid', 1]);
  // 模型×小时
  const modelHeat = findEvent(events, TELEMETRY_OPS.HINCRBY, 'heat:model:2026-10-30:h9');
  assert.ok(modelHeat, '必须写 model×hour 交叉计数');
  assert.deepEqual(modelHeat.args, ['gemini-3.8-flash', 1]);
});

test('latencyToBucket: 延迟分桶边界正确', () => {
  assert.equal(latencyToBucket(0), 'fast');
  assert.equal(latencyToBucket(499), 'fast');
  assert.equal(latencyToBucket(500), 'mid');
  assert.equal(latencyToBucket(1999), 'mid');
  assert.equal(latencyToBucket(2000), 'slow');
  assert.equal(latencyToBucket(4999), 'slow');
  assert.equal(latencyToBucket(5000), 'critical');
  assert.equal(latencyToBucket(99999), 'critical');
  assert.equal(latencyToBucket(0), 'fast');
});

test('LATENCY_BUCKETS: 桶定义稳定且完整（读取端点依赖此顺序）', () => {
  assert.deepEqual(LATENCY_BUCKETS.map(b => b.id), ['fast', 'mid', 'slow', 'critical']);
  assert.deepEqual(LATENCY_BUCKETS.map(b => b.label), ['<0.5s', '0.5–2s', '2–5s', '>5s']);
});

test('telemetryEventsToUpstashCommands: HINCRBY 翻译正确', () => {
  const events = buildTelemetryEvents({ ...BASE, status: 500, latency: 6000 });
  const cmds = telemetryEventsToUpstashCommands(events);
  const hincr = cmds.find(c => c[0] === 'HINCRBY' && c[1] === 'heat:status:2026-10-30:h9');
  assert.ok(hincr, 'HINCRBY 必须出现在命令数组');
  assert.deepEqual(hincr, ['HINCRBY', 'heat:status:2026-10-30:h9', '500', '1']);
});

test('telemetryEventsToRedisPromises: HINCRBY 翻译成 redis.hincrby', () => {
  const calls = [];
  const fakeRedis = new Proxy({}, {
    get(_t, prop) {
      return (...args) => { calls.push([prop, ...args]); return Promise.resolve(1); };
    },
  });
  const events = buildTelemetryEvents(BASE);
  telemetryEventsToRedisPromises(fakeRedis, events);
  const hincr = calls.find(c => c[0] === 'hincrby' && c[1] === 'heat:status:2026-10-30:h9');
  assert.ok(hincr, 'redis.hincrby 必须被调用');
  assert.deepEqual([hincr[2], hincr[3]], ['200', 1]);
});

test('uaToClientType: User-Agent 分类正确', () => {
  assert.equal(uaToClientType('curl/8.0'), 'curl');
  assert.equal(uaToClientType('python-requests/2.31'), 'python');
  assert.equal(uaToClientType('python-httpx/0.27'), 'python');
  assert.equal(uaToClientType('node-fetch/3.0'), 'node');
  assert.equal(uaToClientType('PostmanRuntime/7.32'), 'postman');
  assert.equal(uaToClientType('Mozilla/5.0 (Macintosh) Chrome/120'), 'browser');
  assert.equal(uaToClientType('Mozilla/5.0 (Windows NT 10.0) Firefox/121'), 'browser');
  assert.equal(uaToClientType('some-custom-sdk'), 'other');
  assert.equal(uaToClientType(''), 'other');
  assert.equal(uaToClientType('unknown'), 'other');
});

test('tokensToBucket: 输入 token 分桶边界正确', () => {
  assert.equal(tokensToBucket(0), 'none');
  assert.equal(tokensToBucket(500), 'tiny');
  assert.equal(tokensToBucket(501), 'small');
  assert.equal(tokensToBucket(2000), 'small');
  assert.equal(tokensToBucket(2001), 'medium');
  assert.equal(tokensToBucket(8000), 'medium');
  assert.equal(tokensToBucket(8001), 'large');
  assert.equal(tokensToBucket(999999), 'large');
  assert.equal(tokensToBucket(-5), 'none');
});

test('CLIENT_TYPES/TOKEN_BUCKETS: 定义稳定且完整（读取端点依赖此顺序）', () => {
  assert.deepEqual(CLIENT_TYPES.map(c => c.id), ['curl', 'python', 'node', 'postman', 'browser', 'other']);
  assert.deepEqual(TOKEN_BUCKETS.map(b => b.id), ['none', 'tiny', 'small', 'medium', 'large']);
  assert.deepEqual(TOKEN_BUCKETS.map(b => b.label), ['0', '1–500', '501–2k', '2k–8k', '>8k']);
});

test('buildTelemetryEvents: 来源与 token 交叉计数写入正确', () => {
  const events = buildTelemetryEvents({ ...BASE, ua: 'curl/8.0', inputTokens: 1200 });
  const clientHeat = findEvent(events, TELEMETRY_OPS.HINCRBY, 'heat:client:2026-10-30:h9');
  assert.ok(clientHeat, '必须写 client×hour 交叉计数');
  assert.deepEqual(clientHeat.args, ['curl', 1]);
  const tokenHeat = findEvent(events, TELEMETRY_OPS.HINCRBY, 'heat:token:2026-10-30:h9');
  assert.ok(tokenHeat, '必须写 token×hour 交叉计数');
  // 1200 token → small 桶（501–2k）
  assert.deepEqual(tokenHeat.args, ['small', 1]);
});

test('buildTelemetryEvents: 无 inputTokens 时 token 分桶记为 0（none）', () => {
  const events = buildTelemetryEvents({ ...BASE, inputTokens: 0 });
  const tokenHeat = findEvent(events, TELEMETRY_OPS.HINCRBY, 'heat:token:2026-10-30:h9');
  assert.ok(tokenHeat, '必须写 token×hour 交叉计数');
  assert.deepEqual(tokenHeat.args, ['none', 1]);
});

test('buildTelemetryEvents: 错误状态码×小时只在失败时写入（错误板块专用）', () => {
  // 失败请求：必须写 heat:error
  const bad = buildTelemetryEvents({ ...BASE, status: 429 });
  const badHeat = findEvent(bad, TELEMETRY_OPS.HINCRBY, 'heat:error:2026-10-30:h9');
  assert.ok(badHeat, '失败请求必须写 error×hour 交叉计数');
  assert.deepEqual(badHeat.args, ['429', 1]);

  // 成功请求：不写 heat:error
  const ok = buildTelemetryEvents(BASE);
  const okHeat = findEvent(ok, TELEMETRY_OPS.HINCRBY, 'heat:error:2026-10-30:h9');
  assert.equal(okHeat, undefined, '成功请求不写 error×hour 交叉计数');
});
