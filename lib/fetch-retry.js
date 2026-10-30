// lib/fetch-retry.js
// 上游请求的重试策略（Vercel 与 Cloudflare Worker 共用）
//
// ⚠️ 背景：此前两端各写一份 fetchWithRetry，行为不同：
//    · Vercel 端只重试**网络异常**（fetch throw），上游返回 5xx 直接透传
//    · CF 端会重试 502/503/429
//    结果是同一次上游抖动在备份部署上直接失败、在主部署上却能恢复。
//    本模块统一为「网络异常 + 可重试状态码」都重试。

export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 524]);

/**
 * 统一的 fetch + 重试。
 *
 * @param {string} url
 * @param {object} options fetch 选项
 * @param {number} startTime 起始时间戳（用于总时长预算）
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=2] 总尝试次数（含首次）
 * @param {number} [opts.requestTimeoutMs=25000] 单次请求超时
 * @param {number} [opts.totalTimeoutMs=45000] 总时长预算
 * @param {Set<number>} [opts.retryableStatus] 可重试状态码集合
 * @param {(info:{attempt:number,status:number,waitMs:number})=>void} [opts.onRetry]
 * @returns {Promise<Response>} 带上 `_retries` 属性表示实际重试次数
 */
export async function fetchWithRetry(url, options, startTime, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 2;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 25000;
  const totalTimeoutMs = opts.totalTimeoutMs ?? 45000;
  const retryableStatus = opts.retryableStatus ?? RETRYABLE_STATUS;
  const onRetry = opts.onRetry;

  let lastError = null;
  let retries = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= totalTimeoutMs) break;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.min(requestTimeoutMs, Math.max(1000, totalTimeoutMs - elapsed))
      );
      let resp;
      try {
        resp = await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (retryableStatus.has(resp.status) && attempt < maxAttempts) {
        const waitMs = computeBackoffMs(resp, attempt);
        const remaining = totalTimeoutMs - (Date.now() - startTime);
        if (waitMs < remaining) {
          retries++;
          onRetry?.({ attempt, status: resp.status, waitMs });
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
      }

      resp._retries = retries;
      // 兼容旧字段（CF 端历史读取 response.retries）
      try { resp.retries = retries; } catch { /* Response 属性只读时忽略 */ }
      return resp;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const waitMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        const remaining = totalTimeoutMs - (Date.now() - startTime);
        if (waitMs < remaining) {
          retries++;
          onRetry?.({ attempt, status: 0, waitMs });
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
      }
      break;
    }
  }

  throw lastError || new Error('All retry attempts failed');
}

/**
 * 退避时长：
 *   · 429 优先遵循上游的 Retry-After（封顶 10s）
 *   · 其它状态码用指数退避（500ms → 1s → 2s …，封顶 5s）
 */
function computeBackoffMs(resp, attempt) {
  if (resp?.status === 429) {
    const retryAfter = parseInt(resp.headers?.get?.('Retry-After') || '', 10);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.min(retryAfter, 10) * 1000;
    }
    return Math.min(1000 * attempt, 5000);
  }
  return Math.min(500 * Math.pow(2, attempt - 1), 5000);
}
