// gemini-transparent-proxy/lib/utils.js

/**
 * 根据北京时间 15:00 刷新点计算配额日期
 * 如果当前时间在 15:00 之前，则属于前一天的配额周期
 */
export function getQuotaDate() {
  const now = new Date();
  // 将当前时间减去 15 小时
  const offsetDate = new Date(now.getTime() - 15 * 60 * 60 * 1000);
  return offsetDate.toISOString().split('T')[0];
}
