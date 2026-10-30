// gemini-transparent-proxy/lib/rate-limit.js
//
// 限流公共实现：请求数（RPM，滑动窗口）+ 输入 token（TPM，滑动窗口）。
//
// 本模块刻意「零第三方依赖」：Redis 客户端由调用方注入（参数 `redis`），
// 因此单元测试可以注入一个假 Redis，无需真实 Upstash 连接。
//
// 设计原则（沿用原实现，不要随意改动）：
//   1. 失败开放（fail-open）：Redis 异常时放行请求，只打日志，绝不因限流器故障而中断服务。
//   2. `fingerprint === 'anon'`（未带 Bearer Key）不参与限流 —— 未认证请求没有可归属的配额主体。
//   3. 限流只对「OpenAI 兼容端点」生效；原生 Google 端点（generateContent 等）不拦。
//
// ⚠️ CF Worker 端使用内存版滑动窗口（cloudflare-worker/src/limiters.js），
//    与本模块算法等价但存储层不同（Worker 实例内存 vs Upstash Redis）。
//    两端的窗口长度、比较口径必须保持一致。

// ⚠️ 必须带 .js 扩展名：Next.js 能解析无扩展名导入，但原生 Node ESM 不能
//    （本模块要被 `node --test` 直接引入）。
import { TPM_LIMITS, estimateInputTokens } from './token-limit.js';

export const RATE_LIMIT_WINDOW_MS = 60 * 1000;

/** 默认 RPM 上限（两端一致；可用 RATE_LIMIT_RPM 覆盖，0 = 关闭）。 */
export const DEFAULT_RPM_LIMIT = 15;

/**
 * 解析限流归属主体（subject）。
 *
 * ⚠️ 两端必须用同一套归属规则，否则同一个客户端在 Vercel 与 CF Worker
 *    会被算进不同的桶，限流额度也随之不一致：
 *      · Vercel 端：按 API Key 指纹（lib/rate-limit.js 的 Redis 实现）
 *      · CF 端：历史上按客户端 IP → 同一批用户换到 CF 就拿到了另一份额度
 *
 * 规则：**有 API Key → 按 Key 指纹归因；无 API Key（anon）→ 无归属主体 → 不限流**。
 * （与 lib/rate-limit.js 中 fingerprint === 'anon' 不限流的既有约定一致。）
 *
 * @param {string} fingerprint API Key 指纹；空 / 'anon' → null
 * @returns {string|null} 归属主体；null 表示不限流
 */
export function resolveRateLimitSubject(fingerprint) {
  if (!fingerprint || fingerprint === 'anon') return null;
  return `fp:${fingerprint}`;
}

/** 解析 RPM 上限。NaN / 负数 / 0 一律视为「不限流」。 */
export function parseRpmLimit(raw) {
  const n = parseInt(raw || String(DEFAULT_RPM_LIMIT), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 由 API Key 计算客户端指纹（SHA-1 前 4 字节 → 8 位十六进制）。
 * 用于限流与遥测归因。计算失败时回退为 'anon'。
 */
export async function computeClientFingerprint(apiKey) {
  try {
    const keyData = new TextEncoder().encode(apiKey);
    const hashBuf = await crypto.subtle.digest('SHA-1', keyData);
    const hashArr = Array.from(new Uint8Array(hashBuf));
    return hashArr.slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return 'anon';
  }
}

// ── RPM：每分钟请求数（ZSET 滑动窗口，Lua 保证原子性）──
const RPM_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {1, oldest[2]}
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, math.ceil(window / 1000) + 60)
return {0, count + 1}
`;

// ── TPM：每分钟输入 token 总量（ZSET 滑动窗口，member 形如 "<tokens>:<ts>:<rand>"）──
const TPM_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local items = redis.call('ZRANGEBYSCORE', key, now - window, now)
local sum = 0
for i=1,#items do
  local c = string.match(items[i], '^(%d+)')
  if c then sum = sum + tonumber(c) end
end
if sum + cost > limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfter = 60
  if oldest[2] then retryAfter = math.ceil((tonumber(oldest[2]) + window - now) / 1000) end
  return {0, sum, retryAfter}
end
redis.call('ZADD', key, now, cost .. ':' .. now .. ':' .. math.random())
redis.call('PEXPIRE', key, window + 2000)
return {1, sum + cost, 0}
`;

/**
 * RPM 限流检查。
 * @returns {{ rejected: boolean, retryAfter: number, limit: number }}
 */
export async function checkRpmLimit({ redis, fingerprint, rpmLimit, nowMs = Date.now() }) {
  if (!redis || !rpmLimit || rpmLimit <= 0 || fingerprint === 'anon') {
    return { rejected: false, retryAfter: 0, limit: rpmLimit || 0 };
  }
  const WINDOW_MS = RATE_LIMIT_WINDOW_MS;
  const rlKey = `ratelimit:${fingerprint}`;
  try {
    const member = `${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await redis.eval(RPM_SCRIPT, [rlKey], [String(nowMs), String(WINDOW_MS), String(rpmLimit), member]);
    const rejected = Array.isArray(res) && Number(res[0]) === 1;
    if (!rejected) return { rejected: false, retryAfter: 0, limit: rpmLimit };
    const oldestScore = Number(res[1]);
    let retryAfter = 60;
    if (Number.isFinite(oldestScore) && oldestScore > 0) {
      retryAfter = Math.max(1, Math.ceil((oldestScore + WINDOW_MS - nowMs) / 1000));
    }
    return { rejected: true, retryAfter, limit: rpmLimit };
  } catch (e) {
    // 失败开放：限流器故障不能影响正常服务
    console.error(`[rate-limit] RPM limiter error (fail-open): ${e?.message || e}`);
    return { rejected: false, retryAfter: 0, limit: rpmLimit };
  }
}

/**
 * TPM 限流检查。
 * @param {object}  opts
 * @param {object}  opts.redis           Redis 客户端（可为 null → 不限流）
 * @param {string}  opts.fingerprint     客户端指纹，'anon' → 不限流
 * @param {string}  opts.modelId         模型 id，用于查 TPM_LIMITS
 * @param {string|object} opts.body       请求体（字符串或已解析对象），用于估算输入 token
 * @param {boolean} opts.openAICompat    是否 OpenAI 兼容端点（false → 不限流）
 * @returns {{ rejected: boolean, retryAfter: number, inputTokens: number, limit: number }}
 */
export async function checkTpmLimit({ redis, fingerprint, modelId, body, openAICompat = true, nowMs = Date.now() }) {
  const limit = TPM_LIMITS[modelId];
  if (!openAICompat || !limit || !redis || fingerprint === 'anon') {
    // 与原实现一致：未进入限流判定时 inputTokens 保持 0（遥测按 0 记录）
    return { rejected: false, retryAfter: 0, inputTokens: 0, limit: limit || 0 };
  }
  let parsedBody;
  try {
    parsedBody = typeof body === 'string' ? JSON.parse(body || '{}') : (body || {});
  } catch {
    parsedBody = {};
  }
  const inputTokens = estimateInputTokens(parsedBody);
  const WINDOW_MS = RATE_LIMIT_WINDOW_MS;
  const tpmKey = `tpm:${modelId}:${fingerprint}`;
  try {
    const res = await redis.eval(TPM_SCRIPT, [tpmKey], [String(nowMs), String(WINDOW_MS), String(limit), String(inputTokens)]);
    const allowed = Array.isArray(res) && Number(res[0]) === 1;
    if (!allowed) {
      const retryAfter = Math.max(1, Number(res[2]) || 60);
      return { rejected: true, retryAfter, inputTokens, limit };
    }
    return { rejected: false, retryAfter: 0, inputTokens, limit };
  } catch (e) {
    console.error(`[rate-limit] TPM limiter error (fail-open): ${e?.message || e}`);
    return { rejected: false, retryAfter: 0, inputTokens, limit };
  }
}
