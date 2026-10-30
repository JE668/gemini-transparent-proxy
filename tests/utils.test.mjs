// tests/utils.test.mjs
//
// 配额日界（quota date）的回归测试。
//
// ⚠️ 背景：旧实现把「当前时刻减 15 小时」当作配额日界，
//    实际翻转点落在北京时间 23:00，但注释、README、Dashboard 倒计时
//    三处都声称是 15:00 —— 三方互相矛盾。
//    现在统一为：**北京时间 15:00 翻转**（对应 UTC 07:00）。
//
// 所有 Redis key（quota / timeline / errors / recent / status / clients / latency）
// 都以这个日期为前缀，所以它的正确性直接决定 Dashboard 是否串日。
//
// 标签约定：**配额日标签 = 该配额周期的起始自然日**。
//   配额周期 = 北京时间 [15:00, 次日 15:00)，标签取起始那一天的日期。
//   · 北京 10-30 14:59 → 周期 [10-29 15:00, 10-30 15:00) → 标签 '2026-10-29'
//   · 北京 10-30 15:00 → 周期 [10-30 15:00, 10-31 15:00) → 标签 '2026-10-30'
// （旧实现减 15 小时 → 翻转点在北京 23:00，标签同样是「周期起始日」；
//   本次只把翻转点修正到文档声明的 15:00，不改变标签语义。）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getQuotaDate,
  getPreviousQuotaDate,
  getBeijingHour,
  getSecondsUntilQuotaReset,
  QUOTA_RESET_HOUR_BEIJING,
} from '../lib/utils.js';

/** 构造一个 UTC 时刻 */
function utc(y, m, d, hh = 0, mm = 0, ss = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
}

test('QUOTA_RESET_HOUR_BEIJING: 固定为 15', () => {
  assert.equal(QUOTA_RESET_HOUR_BEIJING, 15);
});

test('getQuotaDate: 北京时间 15:00 之前仍属于上一个配额周期', () => {
  // 2026-10-30 14:59 北京时间 == 2026-10-30 06:59 UTC → 周期起始日 = 10-29
  assert.equal(getQuotaDate(utc(2026, 10, 30, 6, 59)), '2026-10-29');
  // 当天 00:00 北京时间 == 10-29 16:00 UTC → 周期起始日 = 10-29
  assert.equal(getQuotaDate(utc(2026, 10, 29, 16, 0)), '2026-10-29');
});

test('getQuotaDate: 北京时间 15:00 起翻转到新配额周期', () => {
  // 2026-10-30 15:00 北京时间 == 2026-10-30 07:00 UTC → 周期起始日 = 10-30
  assert.equal(getQuotaDate(utc(2026, 10, 30, 7, 0)), '2026-10-30');
  // 2026-10-30 23:59 北京时间 == 15:59 UTC → 仍是 10-30 周期
  assert.equal(getQuotaDate(utc(2026, 10, 30, 15, 59)), '2026-10-30');
});

test('getQuotaDate: 边界点精确（14:59:59 → 前一周期，15:00:00 → 新周期）', () => {
  assert.equal(getQuotaDate(utc(2026, 10, 30, 6, 59, 59)), '2026-10-29');
  assert.equal(getQuotaDate(utc(2026, 10, 30, 7, 0, 0)), '2026-10-30');
});

test('getQuotaDate: 跨月 / 跨年边界正确', () => {
  // 2026-10-31 15:00 北京时间 == 10-31 07:00 UTC → 周期起始日 = 10-31
  assert.equal(getQuotaDate(utc(2026, 10, 31, 7, 0)), '2026-10-31');
  // 2026-12-31 15:00 北京时间 == 12-31 07:00 UTC → 周期起始日 = 12-31
  assert.equal(getQuotaDate(utc(2026, 12, 31, 7, 0)), '2026-12-31');
  // 2027-01-01 15:00 北京时间 == 2027-01-01 07:00 UTC → 周期起始日 = 2027-01-01
  assert.equal(getQuotaDate(utc(2027, 1, 1, 7, 0)), '2027-01-01');
});

test('getPreviousQuotaDate: 基于配额日往前推一天（不是自然日）', () => {
  assert.equal(getPreviousQuotaDate(utc(2026, 10, 30, 6, 59)), '2026-10-28');
  assert.equal(getPreviousQuotaDate(utc(2026, 10, 30, 7, 0)), '2026-10-29');
  assert.equal(getPreviousQuotaDate(utc(2027, 1, 1, 7, 0)), '2026-12-31');
});

test('getPreviousQuotaDate: 与 getQuotaDate 严格相差一天', () => {
  for (let h = 0; h < 24; h++) {
    const now = utc(2026, 10, 30, h);
    const cur = getQuotaDate(now);
    const prev = getPreviousQuotaDate(now);
    const diff = (new Date(`${cur}T00:00:00Z`) - new Date(`${prev}T00:00:00Z`)) / 86400000;
    assert.equal(diff, 1, `${now.toISOString()} 的前后配额日必须恰好相差 1 天`);
  }
});

test('getBeijingHour: 返回北京时间小时（0–23）', () => {
  assert.equal(getBeijingHour(utc(2026, 10, 30, 0)), 8);
  assert.equal(getBeijingHour(utc(2026, 10, 30, 7)), 15);
  assert.equal(getBeijingHour(utc(2026, 10, 30, 15)), 23);
  assert.equal(getBeijingHour(utc(2026, 10, 30, 16)), 0);
});

test('getSecondsUntilQuotaReset: 指向下一个北京时间 15:00', () => {
  // 北京时间 14:00 → 还有 1 小时
  assert.equal(getSecondsUntilQuotaReset(utc(2026, 10, 30, 6, 0)), 3600);
  // 北京时间 15:00 整点 → 距下一轮 24 小时
  assert.equal(getSecondsUntilQuotaReset(utc(2026, 10, 30, 7, 0)), 86400);
  // 北京时间 23:59 → 还有 15 小时 1 分钟
  assert.equal(getSecondsUntilQuotaReset(utc(2026, 10, 30, 15, 59)), 15 * 3600 + 60);
});

test('getSecondsUntilQuotaReset: 结果始终为正且不超过 24 小时', () => {
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 15, 30, 45]) {
      const s = getSecondsUntilQuotaReset(utc(2026, 10, 30, h, m));
      assert.ok(s > 0 && s <= 86400, `${h}:${m} 的倒计时必须在 (0, 86400] 区间，实际 ${s}`);
    }
  }
});
