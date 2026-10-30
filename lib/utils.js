// gemini-transparent-proxy/lib/utils.js
//
// 共享的工具函数（Vercel 与 Cloudflare Worker 共用）。
//
// ⚠️ 配额日界（quota date）是全项目的「天」划分基准：
//    所有配额 / 时间线 / 错误日志 / 最近请求的 Redis key 都以它为前缀。
//    两端各写一份实现时曾出现「Vercel 减 15 小时、CF 也减 15 小时但注释说 15:00」
//    的三方不一致（实际翻转点是北京时间 23:00）。
//    现在统一为：**北京时间 15:00 翻转**（对应 UTC 07:00）。

/** 配额周期翻转点（北京时间小时）。Google 免费层配额在此刷新。 */
export const QUOTA_RESET_HOUR_BEIJING = 15;

/** 北京时间与 UTC 的小时差。 */
const BEIJING_OFFSET_HOURS = 8;

/**
 * 距离「下一次配额日翻转」经过的小时数（用于减法）。
 *
 * 北京时间 15:00 == UTC 07:00，所以要得到「当前属于哪个配额日」，
 * 只需把当前时刻减去 (15 - 8) = 7 小时，再取其 UTC 日期。
 */
const QUOTA_OFFSET_HOURS = QUOTA_RESET_HOUR_BEIJING - BEIJING_OFFSET_HOURS;

/**
 * 根据配额刷新点计算配额日期（YYYY-MM-DD）。
 *
 * ⚠️ 标签语义：**标签 = 配额周期的起始自然日**。
 *    配额周期 = 北京时间 [15:00, 次日 15:00)。
 *    例（UTC+8）：
 *      · 2026-10-30 14:59 北京时间 → 周期 [10-29 15:00, 10-30 15:00) → 标签 '2026-10-29'
 *      · 2026-10-30 15:00 北京时间 → 周期 [10-30 15:00, 10-31 15:00) → 标签 '2026-10-30'
 *
 * @param {Date} [now] 可注入当前时间（测试用）
 * @returns {string} YYYY-MM-DD
 */
export function getQuotaDate(now = new Date()) {
  const offsetDate = new Date(now.getTime() - QUOTA_OFFSET_HOURS * 60 * 60 * 1000);
  return offsetDate.toISOString().split('T')[0];
}

/**
 * 获取「上一个配额日」的日期（YYYY-MM-DD）。
 *
 * ⚠️ 必须基于 getQuotaDate 往前推一天，不能用 `new Date() - 1 天`：
 *    两个配额日的时长都是 24 小时，但「昨天」的边界同样在 15:00，
 *    用自然日会导致 15:00–24:00 这段时间取到的「昨天」其实是前天的配额周期，
 *    时间线对比图会出现 8 小时的错位。
 *
 * @param {Date} [now] 可注入当前时间（测试用）
 * @returns {string} YYYY-MM-DD
 */
export function getPreviousQuotaDate(now = new Date()) {
  const current = getQuotaDate(now);
  const d = new Date(`${current}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split('T')[0];
}

/**
 * 计算当前北京时间的小时（0–23）。
 * @param {Date} [now]
 * @returns {number}
 */
export function getBeijingHour(now = new Date()) {
  return (now.getUTCHours() + BEIJING_OFFSET_HOURS) % 24;
}

/**
 * 距离下一次配额日翻转的秒数（用于 Dashboard 倒计时）。
 *
 * 翻转点固定为北京时间 15:00（UTC 07:00）。
 * 若当前时刻已过今天的翻转点，则指向明天的翻转点。
 *
 * @param {Date} [now]
 * @returns {number} 剩余秒数
 */
export function getSecondsUntilQuotaReset(now = new Date()) {
  // 当前分钟内已过的毫秒数
  const msElapsedInHour = (now.getUTCMinutes() * 60 + now.getUTCSeconds()) * 1000 + now.getUTCMilliseconds();
  let msUntil = (QUOTA_RESET_HOUR_BEIJING - getBeijingHour(now)) * 60 * 60 * 1000 - msElapsedInHour;
  if (msUntil <= 0) msUntil += 24 * 60 * 60 * 1000;
  return Math.max(0, Math.floor(msUntil / 1000));
}
