// lib/telemetry.js
//
// 共享的遥测事件生成器（Vercel 与 Cloudflare Worker 共用）。
//
// ⚠️ 为什么需要它：
//   1. **Dashboard 空面板**：app/api/quota/route.js 读取 `latencySum:{date}:{model}`
//      与 `latencyCount:{date}:{model}` 计算平均延迟，app/api/dashboard/route.js 读取
//      `latency:{model}` 与 `clients:{date}:keys` / `clients:{date}:{fingerprint}` /
//      `client:info:{fingerprint}`，但全仓库**没有任何写入方** —— 这些面板恒为空。
//   2. **代理侧 429 不计遥测**：限流（RPM / TPM）直接 return 429 Response，
//      不经过通用转发路径的遥测写入，Dashboard 上看不到「被代理拦掉的请求」，
//      错误率与请求总量都偏低。
//
// 本模块只生成「事件描述」，不关心存储实现：
//   Vercel 端把事件翻译成 @upstash/redis 的方法调用，
//   CF Worker 端把事件翻译成 Upstash REST 的命令数组。
// 这样两端记录的 key、口径、清理策略完全一致。

/** 客户端指纹信息在 Redis 中的保留时长（秒）。 */
export const CLIENT_INFO_TTL_SECONDS = 86400;

/** 慢请求阈值（毫秒）。 */
export const SLOW_REQUEST_THRESHOLD_MS = 10000;

/**
 * 事件 op 取值：
 *   incr / incrby / lpush / ltrim / zadd / zremrangebyscore /
 *   zremrangebyrank / sadd / hset / expire
 */
export const TELEMETRY_OPS = Object.freeze({
  INCR: 'incr',
  INCRBY: 'incrby',
  LPUSH: 'lpush',
  LTRIM: 'ltrim',
  ZADD: 'zadd',
  ZREMRANGEBYSCORE: 'zremrangebyscore',
  ZREMRANGEBYRANK: 'zremrangebyrank',
  SADD: 'sadd',
  HSET: 'hset',
  EXPIRE: 'expire',
});

/**
 * 生成一次请求对应的全部遥测事件。
 *
 * @param {object} opts
 * @param {string} opts.date         配额日（YYYY-MM-DD），由 getQuotaDate() 得到
 * @param {number} opts.hour         北京时间小时（0–23）
 * @param {number} opts.status       HTTP 状态码
 * @param {string} opts.model        模型 id（未知时传 'unknown-model'）
 * @param {number} opts.latency      端到端耗时（毫秒）
 * @param {string} opts.ua           User-Agent
 * @param {string} opts.ip           客户端 IP
 * @param {string} [opts.fingerprint] 客户端指纹（用于客户端维度统计；为空/'anon' 时跳过）
 * @param {number} [opts.inputTokens] 本次请求估计输入 token 数（>0 时写 TPM 滑动窗口）
 * @param {number} [opts.totalRetries] 本次请求的重试次数
 * @param {boolean} [opts.success]   是否成功（默认按 status < 400 推断）
 * @param {string} [opts.errorMessage] 自定义错误文案（覆盖默认的「状态码 + 状态文案」）
 * @param {number} [opts.slowThresholdMs] 慢请求阈值
 * @returns {Array<{op: string, key: string, args: any[]}>}
 */
export function buildTelemetryEvents({
  date,
  hour,
  status,
  model,
  latency = 0,
  ua = 'unknown',
  ip = 'unknown',
  fingerprint = '',
  inputTokens = 0,
  totalRetries = 0,
  success,
  errorMessage,
  slowThresholdMs = SLOW_REQUEST_THRESHOLD_MS,
}) {
  const events = [];
  const isSuccess = success === undefined ? status < 400 : !!success;
  const finalModel = model || 'unknown-model';
  const nowIso = new Date().toISOString();
  const clientFp = fingerprint && fingerprint !== 'anon' ? fingerprint : '';

  // ── 1. 状态码计数（always）──
  events.push({ op: TELEMETRY_OPS.INCR, key: `status:${date}:${status}`, args: [] });

  // ── 2. 时间线（always）──
  events.push({ op: TELEMETRY_OPS.INCR, key: `timeline:${date}:h${hour}`, args: [] });

  // ── 3. 最近请求（保留最新 30 条）──
  const recentEntry = JSON.stringify({
    ts: nowIso,
    status,
    model: finalModel,
    latency,
    ua,
    ip,
  });
  events.push({ op: TELEMETRY_OPS.LPUSH, key: `recent:${date}`, args: [recentEntry] });
  events.push({ op: TELEMETRY_OPS.LTRIM, key: `recent:${date}`, args: [0, 29] });

  // ── 4. 错误日志（仅失败，保留最新 20 条）──
  if (!isSuccess) {
    const errorEntry = JSON.stringify({
      ts: nowIso,
      status,
      model: finalModel,
      latency,
      message: errorMessage || `${status} ${statusTextFor(status)}`,
      ua,
      ip,
    });
    events.push({ op: TELEMETRY_OPS.LPUSH, key: `errors:${date}`, args: [errorEntry] });
    events.push({ op: TELEMETRY_OPS.LTRIM, key: `errors:${date}`, args: [0, 19] });
  }

  // ── 5. 配额计数（仅成功）──
  if (isSuccess) {
    events.push({ op: TELEMETRY_OPS.INCR, key: `quota:${date}:${finalModel}`, args: [] });
    events.push({ op: TELEMETRY_OPS.INCR, key: `quota:global:${date}`, args: [] });

    // TPM 滑动窗口：score = 时间戳 ms，member = 输入 token 数
    if (inputTokens > 0) {
      const tpmKey = `tpm:${date}:${finalModel}`;
      events.push({
        op: TELEMETRY_OPS.ZADD,
        key: tpmKey,
        args: [{ score: Date.now(), member: String(inputTokens) }],
      });
      events.push({
        op: TELEMETRY_OPS.ZREMRANGEBYSCORE,
        key: tpmKey,
        args: [0, Date.now() - 60000],
      });
    }
  }

  // ── 6. 平均延迟（Dashboard 的「平均延迟」指标；此前只有读取方没有写入方）──
  events.push({ op: TELEMETRY_OPS.INCRBY, key: `latencySum:${date}:${finalModel}`, args: [Math.max(0, Math.round(latency))] });
  events.push({ op: TELEMETRY_OPS.INCR, key: `latencyCount:${date}:${finalModel}`, args: [] });

  // ── 7. 客户端维度（此前只有读取方没有写入方，客户端面板恒空）──
  if (clientFp) {
    events.push({ op: TELEMETRY_OPS.SADD, key: `clients:${date}:keys`, args: [clientFp] });
    events.push({ op: TELEMETRY_OPS.INCR, key: `clients:${date}:${clientFp}`, args: [] });
    events.push({
      op: TELEMETRY_OPS.HSET,
      key: `client:info:${clientFp}`,
      args: [
        { ua, ip, lastSeen: nowIso },
      ],
    });
    events.push({ op: TELEMETRY_OPS.EXPIRE, key: `client:info:${clientFp}`, args: [CLIENT_INFO_TTL_SECONDS] });
  }

  // ── 8. 重试次数 ──
  if (totalRetries > 0) {
    events.push({ op: TELEMETRY_OPS.INCRBY, key: `retries:${date}`, args: [totalRetries] });
  }

  // ── 9. 慢请求（sorted set：score = 延迟 ms，member = 请求信息；保留最慢 50 条）──
  if (latency >= slowThresholdMs) {
    const slowEntry = JSON.stringify({
      ts: nowIso,
      status,
      model: finalModel,
      ua,
      ip,
    });
    events.push({ op: TELEMETRY_OPS.ZADD, key: `slow:${date}`, args: [{ score: latency, member: slowEntry }] });
    events.push({ op: TELEMETRY_OPS.ZREMRANGEBYRANK, key: `slow:${date}`, args: [0, -51] });
  }

  return events;
}

/**
 * 代理侧限流拒绝（RPM / TPM 超限）时的遥测事件。
 *
 * ⚠️ 此前限流直接 return 429，不写任何遥测 ——
 *    Dashboard 的「请求总量 / 错误率 / 错误日志」都看不到这些请求，
 *    运维会误以为流量正常。
 *
 * @param {object} opts 同 buildTelemetryEvents
 * @returns {Array<{op: string, key: string, args: any[]}>}
 */
export function buildRateLimitTelemetryEvents({
  date,
  hour,
  status = 429,
  model,
  latency = 0,
  ua = 'unknown',
  ip = 'unknown',
  fingerprint = '',
  reason = 'rate_limit_exceeded',
}) {
  return buildTelemetryEvents({
    date,
    hour,
    status,
    model,
    latency,
    ua,
    ip,
    fingerprint,
    success: false,
    // 限流不是上游错误，用 reason 覆盖错误文案
    errorMessage: reason,
  });
}

/**
 * 把遥测事件翻译成 @upstash/redis 的 Promise 调用（Vercel 端）。
 *
 * @param {import('@upstash/redis').Redis} redis
 * @param {Array<{op: string, key: string, args: any[]}>} events
 * @returns {Promise<any[]>} 每个元素对应一个事件
 */
export function telemetryEventsToRedisPromises(redis, events) {
  if (!redis || !events || events.length === 0) return [];
  return events.map(ev => {
    switch (ev.op) {
      case TELEMETRY_OPS.INCR:
        return redis.incr(ev.key);
      case TELEMETRY_OPS.INCRBY:
        return redis.incrby(ev.key, ev.args[0]);
      case TELEMETRY_OPS.LPUSH:
        return redis.lpush(ev.key, ev.args[0]);
      case TELEMETRY_OPS.LTRIM:
        return redis.ltrim(ev.key, ev.args[0], ev.args[1]);
      case TELEMETRY_OPS.ZADD:
        return redis.zadd(ev.key, ev.args[0]);
      case TELEMETRY_OPS.ZREMRANGEBYSCORE:
        return redis.zremrangebyscore(ev.key, ev.args[0], ev.args[1]);
      case TELEMETRY_OPS.ZREMRANGEBYRANK:
        return redis.zremrangebyrank(ev.key, ev.args[0], ev.args[1]);
      case TELEMETRY_OPS.SADD:
        return redis.sadd(ev.key, ev.args[0]);
      case TELEMETRY_OPS.HSET:
        return redis.hset(ev.key, ev.args[0]);
      case TELEMETRY_OPS.EXPIRE:
        return redis.expire(ev.key, ev.args[0]);
      default:
        return Promise.resolve(null);
    }
  });
}

/**
 * 把遥测事件翻译成 Upstash REST 的命令数组（Cloudflare Worker 端）。
 *
 * REST pipeline 的命令格式为 `['CMD', 'arg1', 'arg2', ...]`。
 *
 * @param {Array<{op: string, key: string, args: any[]}>} events
 * @returns {Array<string[]>}
 */
export function telemetryEventsToUpstashCommands(events) {
  if (!events || events.length === 0) return [];
  return events.map(ev => {
    switch (ev.op) {
      case TELEMETRY_OPS.INCR:
        return ['INCR', ev.key];
      case TELEMETRY_OPS.INCRBY:
        return ['INCRBY', ev.key, String(ev.args[0])];
      case TELEMETRY_OPS.LPUSH:
        return ['LPUSH', ev.key, String(ev.args[0])];
      case TELEMETRY_OPS.LTRIM:
        return ['LTRIM', ev.key, String(ev.args[0]), String(ev.args[1])];
      case TELEMETRY_OPS.ZADD:
        return ['ZADD', ev.key, String(ev.args[0].score), String(ev.args[0].member)];
      case TELEMETRY_OPS.ZREMRANGEBYSCORE:
        return ['ZREMRANGEBYSCORE', ev.key, String(ev.args[0]), String(ev.args[1])];
      case TELEMETRY_OPS.ZREMRANGEBYRANK:
        return ['ZREMRANGEBYRANK', ev.key, String(ev.args[0]), String(ev.args[1])];
      case TELEMETRY_OPS.SADD:
        return ['SADD', ev.key, String(ev.args[0])];
      case TELEMETRY_OPS.HSET: {
        const fields = ev.args[0];
        const cmd = ['HSET', ev.key];
        for (const [k, v] of Object.entries(fields)) cmd.push(k, String(v));
        return cmd;
      }
      case TELEMETRY_OPS.EXPIRE:
        return ['EXPIRE', ev.key, String(ev.args[0])];
      default:
        return ['NOP'];
    }
  });
}

/** 状态码 → 默认状态文案。 */
function statusTextFor(status) {
  const map = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return map[status] || 'Error';
}
