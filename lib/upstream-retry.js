// lib/upstream-retry.js
//
// 上游请求的「重试 + 模型降级」策略（零依赖纯模块，可直接单元测试）。
//
// ⚠️ 为什么需要它：Responses API（Codex 主客户端）原先完全没有重试与降级，
//    Google 侧一限流（429）或临时 5xx，Agent 任务就直接失败中断。
//    本模块把 Chat Completions 路径早已验证过的策略原样搬过来，
//    并让 Vercel 与 CF Worker 共用同一份实现，避免行为分叉。
//
// 策略（与 app/api/[[...path]]/route.js 的聊天路径保持一致）：
//   1. 首次请求
//   2. 命中可重试状态 / 网络错误 / 超时：
//      - 网络错误或请求超时（上游挂死）→ 直接进入降级（同模型重试无意义，
//        因为上游压根没响应，重试只会再挂一次）
//      - 429 → 按上游 Retry-After 退避（封顶 10s），同模型重试一次；
//              重试成功则直接返回，重试仍失败则进入降级
//      - 500 / 524 → 直接降级
//      - 503 → 用 clone() 读错误体判断是否「容量不足」；是则降级，否则原样返回
//   3. 降级：按 MODEL_FALLBACKS 换模型再请求一次；
//      降级也失败 → 返回「原始那次失败」的响应（保留其状态码与错误体）
//
// 降级生效时对客户端可见的 model 字段保持「客户端请求的模型」不变，
// 避免客户端因模型名变化而改变自身行为；实际使用的模型只写服务端日志。

import { MODEL_FALLBACKS as DEFAULT_FALLBACKS } from './model-fallbacks.js';

/** 值得重试 / 值得降级的上游状态码 */
// ⚠️ 含 502：lib/upstream-retry.js 的 safeFetch 会把「上游网络错误 / 超时」归一化成
//    502/524 响应，这两个状态必须进入「可重试/可降级」集合，否则上游挂死时
//    降级逻辑永远不会触发（本模块改造的核心动因）。
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 524]);

export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(Number(status));
}

/**
 * 解析上游 Retry-After（秒）。
 * @param {Response} response
 * @param {{cap?: number, fallback?: number}} [opts] cap=封顶秒数，fallback=缺省秒数
 * @returns {number} 至少 1 秒
 */
export function parseRetryAfterSeconds(response, { cap = 10, fallback = 5 } = {}) {
  let raw = null;
  if (response && response.headers && typeof response.headers.get === 'function') {
    raw = response.headers.get('Retry-After');
  }
  const parsed = parseInt(raw || String(fallback), 10);
  const n = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(1, Math.min(n, cap));
}

/**
 * Google 503 里表示「容量不足、换模型可能成功」的文案特征。
 * 非字符串 / 空值一律返回 false（原先 CF 侧裸 .includes 会抛错）。
 */
export function isHighDemand503(bodyText) {
  if (!bodyText || typeof bodyText !== 'string') return false;
  return bodyText.includes('UNAVAILABLE') || bodyText.includes('high demand');
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 默认单次上游请求超时（毫秒）。与 lib/fetch-retry.js 的 requestTimeoutMs 一致。
 *  免费层 Gemini 偶发慢（>10s 首 token），给足 25s 再判定「挂死」。 */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 25000;

/**
 * 带超时地调用 fetchFn。
 * 关键差异：上游「挂死」（不返回响应也不关连接）时，裸 fetch 会永久挂起，
 * 模型降级永远等不到触发。这里用 AbortController 把挂死转换为可控失败。
 *
 * @param {Function} fetchFn
 * @param {string}   url
 * @param {object}   init
 * @param {number}   timeoutMs
 * @param {Function} [onTimeout] (ms) => void，超时回调（用于日志）
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(fetchFn, url, init, timeoutMs, onTimeout) {
  // 未配置超时（<=0）时退化为裸 fetch，保持旧行为
  if (!timeoutMs || timeoutMs <= 0) {
    return fetchFn(url, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    onTimeout?.(timeoutMs);
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带重试与模型降级的上游请求。
 *
 * @param {object}   opts
 * @param {Function} opts.fetchFn     (url, init) => Promise<Response>
 * @param {string}   opts.url         上游 URL
 * @param {object}   opts.headers     请求头（鉴权由 fetchFn 负责追加）
 * @param {object}   opts.body        请求体对象（会按目标模型重新序列化）
 * @param {string}   opts.modelId     实际上游模型名（通常等于 body.model）
 * @param {object}   [opts.fallbacks] 模型 → 降级目标映射（默认 MODEL_FALLBACKS）
 * @param {Function} [opts.sleep]     (ms) => Promise<void>，测试可注入
 * @param {Function} [opts.onRetry]   (status, delaySec) => void
 * @param {Function} [opts.onFallback] (from, to, status) => void
 * @param {Function} [opts.isHighDemand] (bodyText) => boolean
 * @param {boolean}  [opts.retryOn429] 是否对 429 做同模型退避重试
 * @param {number}   [opts.requestTimeoutMs] 单次上游请求超时（毫秒，默认 25000；<=0 关闭）
 * @param {Function} [opts.onTimeout] (ms) => void，请求超时回调（用于日志）
 * @returns {Promise<{response: Response, modelId: string, fellBack: boolean, retries: number}>}
 */
export async function fetchWithModelFallback({
  fetchFn,
  url,
  headers,
  body,
  modelId,
  fallbacks,
  sleep = defaultSleep,
  onRetry = null,
  onFallback = null,
  isHighDemand = isHighDemand503,
  retryOn429 = true,
  requestTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  onTimeout = null,
}) {
  const fallbackMap = fallbacks || DEFAULT_FALLBACKS;

  // 构造请求体：换模型时只替换 model 字段，其余参数原样保留
  const buildInit = (targetModel) => ({
    method: 'POST',
    headers,
    body: JSON.stringify(targetModel === modelId ? body : { ...body, model: targetModel }),
  });

  // ⚠️ 包装一次「单次上游调用 + 超时」。上游挂死（无响应）会抛 AbortError/网络错误，
  //    与 HTTP 4xx/5xx 不同——调用方必须能区分「有响应但失败」与「压根没响应」。
  const safeFetch = async (targetModel) => {
    try {
      return await fetchWithTimeout(fetchFn, url, buildInit(targetModel), requestTimeoutMs, onTimeout);
    } catch (err) {
      // 网络错误 / 超时（AbortError）→ 构造一个可识别的失败响应，
      // 让下方统一按「降级」处理。保留原始错误供日志。
      const errName = err?.name || '';
      const isAbort = errName === 'AbortError' || /abort/i.test(String(err?.message || ''));
      const failureStatus = isAbort ? 524 : 502; // 524=源站超时, 502=网络错误（与 Vercel 端口径一致）
      const failureResp = new Response(JSON.stringify({
        error: {
          message: `上游${isAbort ? '超时' : '网络错误'}: ${err?.message || errName || 'unknown'}`,
          type: isAbort ? 'upstream_timeout' : 'upstream_network_error',
          code: failureStatus,
        },
      }), { status: failureStatus, headers: { 'Content-Type': 'application/json' } });
      failureResp._upstreamError = err; // 挂到响应上供日志读取
      return failureResp;
    }
  };

  let response = await safeFetch(modelId);
  // 记住「最初那次失败」，供降级也失败时原样返回（保留最初状态码与错误体，
  // 而非返回同模型重试后的那次响应 —— 与模块头注释及测试契约一致）
  let originalFailure = response;
  let retries = 0;

  if (!isRetryableStatus(response.status)) {
    return { response, modelId, fellBack: false, retries };
  }

  let status = response.status;
  let shouldFallback = false;

  if (status === 429 && retryOn429) {
    // 同模型按上游 Retry-After 退避重试一次（封顶 10s）
    const delaySec = parseRetryAfterSeconds(response);
    if (onRetry) onRetry(status, delaySec);
    await sleep(delaySec * 1000);
    retries++;
    const retryResp = await safeFetch(modelId);
    response = retryResp;
    status = retryResp.status;
    if (!isRetryableStatus(status)) {
      // 同模型重试成功
      return { response, modelId, fellBack: false, retries };
    }
    shouldFallback = true;
  } else if (status === 500 || status === 524) {
    // 500 / 524 直接降级；524 覆盖「上游挂死超时」（safeFetch 把它归一化成 524）
    shouldFallback = true;
  } else if (status === 502) {
    // 网络错误（上游无响应 / 连接被拒）→ 同模型重试无意义（会再挂一次），直接降级
    shouldFallback = true;
  } else if (status === 503) {
    // ⚠️ 用 clone() 读错误体，避免消费掉原响应体导致后续无法转发
    const errText = await response.clone().text().catch(() => '');
    shouldFallback = isHighDemand(errText);
  }

  if (!shouldFallback) {
    return { response, modelId, fellBack: false, retries };
  }

  const fallbackModel = modelId ? fallbackMap[modelId] : null;
  if (!fallbackModel || fallbackModel === modelId) {
    // 没有可降级的目标（或降级目标是自己）→ 原样返回失败响应
    return { response, modelId, fellBack: false, retries };
  }

  const fallbackResp = await safeFetch(fallbackModel);
  retries++;
  if (onFallback) onFallback(modelId, fallbackModel, fallbackResp.status);

  if (isRetryableStatus(fallbackResp.status)) {
    // 降级也失败 → 返回「最初那次失败」的响应（保留最初状态码与错误体）
    return { response: originalFailure, modelId, fellBack: false, retries };
  }

  return { response: fallbackResp, modelId: fallbackModel, fellBack: true, retries };
}

export default fetchWithModelFallback;
