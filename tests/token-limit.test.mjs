// tests/token-limit.test.js
//
// 输入 token 估算的回归测试。
//
// ⚠️ 估算偏小 → 代理放行 → 上游 429（用户看到失败）；
//    估算偏大 → 代理提前 429（用户看到可重试提示）。两类偏差都是 bug，
//    所以这里同时钉住「下限」与「上限」。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TPM_LIMITS, estimateInputTokens, estimateTextTokens } from '../lib/token-limit.js';

test('TPM_LIMITS: 关键模型的额度与配额快照一致', () => {
  assert.equal(TPM_LIMITS['gemma-4-31b-it'], 16000);
  assert.equal(TPM_LIMITS['gemma-4-26b-a4b-it'], 16000);
  assert.equal(TPM_LIMITS['gemini-3.5-flash-lite'], 250000);
  assert.equal(TPM_LIMITS['gemini-3.1-flash-lite'], 250000);
  assert.equal(TPM_LIMITS['antigravity-preview-05-2026'], 100000);
  assert.equal(TPM_LIMITS['gemini-3.8-flash-tts'], 10000);
});

test('estimateInputTokens: 非对象输入返回 0', () => {
  assert.equal(estimateInputTokens(null), 0);
  assert.equal(estimateInputTokens(undefined), 0);
  assert.equal(estimateInputTokens('string'), 0);
  assert.equal(estimateInputTokens(42), 0);
});

test('estimateInputTokens: Chat Completions 字符串 content', () => {
  // 每条 message：4 token 固定开销 + ceil(len/4)
  const n = estimateInputTokens({ messages: [{ role: 'user', content: 'abcdefgh' }] });
  assert.equal(n, 4 + 2);
});

test('estimateInputTokens: 顶层 system 计入', () => {
  const n = estimateInputTokens({
    system: 'abcdefgh',
    messages: [{ role: 'user', content: 'xy' }],
  });
  assert.equal(n, (4 + 2) + (4 + 1));
});

test('estimateInputTokens: 多模态 parts 只统计 text', () => {
  const n = estimateInputTokens({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'abcd' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }],
  });
  assert.equal(n, 4 + 1);
});

test('estimateInputTokens: Responses API 的 instructions + input 字符串都被计入', () => {
  const n = estimateInputTokens({
    instructions: 'abcd',
    input: 'abcdefgh',
  });
  assert.equal(n, (4 + 1) + (4 + 2));
});

test('estimateInputTokens: Responses API 的 input 数组（含多模态 parts）被计入', () => {
  const n = estimateInputTokens({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'abcd' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'abcdefgh' }] },
    ],
  });
  assert.equal(n, (4 + 1) + (4 + 2));
});

test('estimateInputTokens: Responses API 的工具调用参数被计入（Agent 场景关键）', () => {
  const n = estimateInputTokens({
    input: [
      { type: 'function_call', name: 'read_file', arguments: '{"path":"a.txt"}' },
      { type: 'function_call_output', output: 'file contents here' },
    ],
  });
  assert.ok(n > 0, '工具调用参数必须被计入，否则 Agent 大上下文会漏算');
  // arguments(16 字符→4) + name(9 字符→3) + output(18 字符→5)，每项再加 4 token 固定开销
  assert.equal(n, (4 + 4) + (4 + 3) + (4 + 5));
});

test('estimateInputTokens: Chat Completions 的 tool_calls 参数被计入', () => {
  const n = estimateInputTokens({
    messages: [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'grep', arguments: '{"q":"abc"}' },
      }],
    }],
  });
  assert.ok(n > 0, 'tool_calls.arguments 必须被计入');
});

test('estimateInputTokens: 空 body 返回 0', () => {
  assert.equal(estimateInputTokens({}), 0);
  assert.equal(estimateInputTokens({ messages: [] }), 0);
});

test('estimateInputTokens: 结果随文本长度单调递增', () => {
  const a = estimateInputTokens({ messages: [{ role: 'user', content: 'a'.repeat(100) }] });
  const b = estimateInputTokens({ messages: [{ role: 'user', content: 'a'.repeat(200) }] });
  assert.ok(b > a, '估算必须随输入增长');
});

// ── CJK（中英混合）token 估算 ──
// ⚠️ 旧实现对所有文本一律 ceil(len/4)，中文会被低估 3~4 倍：
//    代理以为没超 TPM 墙 → 上游直接 429 → 用户看到不可重试的失败。

test('estimateTextTokens: 纯 ASCII 仍按 ~4 字符/token', () => {
  assert.equal(estimateTextTokens('abcdefgh'), 2);
  assert.equal(estimateTextTokens('a'), 1);
  assert.equal(estimateTextTokens(''), 0);
});

test('estimateTextTokens: 纯中文按 1 字/token（不再被低估 4 倍）', () => {
  const chinese = '你好世界你好世界'; // 8 个汉字
  assert.equal(estimateTextTokens(chinese), 8);
  // 旧实现会得到 ceil(8/4) = 2 —— 明显低估
  assert.ok(estimateTextTokens(chinese) > 8 / 4);
});

test('estimateTextTokens: 中英混合按类别分别估算', () => {
  // 4 个汉字 + 8 个 ASCII 字符 → 4 + ceil(8/4) = 6
  assert.equal(estimateTextTokens('你好世界abcdefgh'), 4 + 2);
});

test('estimateTextTokens: 全角标点按 1 token 计', () => {
  assert.equal(estimateTextTokens('，。！？'), 4);
});

test('estimateTextTokens: 日文假名 / 韩文音节按 1 token 计', () => {
  assert.equal(estimateTextTokens('ひらがな'), 4);
  assert.equal(estimateTextTokens('カタカナ'), 4);
  assert.equal(estimateTextTokens('한국어'), 3);
});

test('estimateTextTokens: Emoji 按 2 token 保守计', () => {
  assert.equal(estimateTextTokens('😀'), 2);
});

test('estimateInputTokens: 中文请求不再被低估（关键回归）', () => {
  const text = '请帮我分析这段代码的潜在性能问题，并给出优化建议。';
  const n = estimateInputTokens({ messages: [{ role: 'user', content: text }] });
  const cjkCount = [...text].filter(ch => /[一-鿿]/.test(ch)).length;
  // 估算值至少要覆盖中文字数（不能低于中文字符数）
  assert.ok(n >= cjkCount, `中文估算 ${n} 不应低于中文字数 ${cjkCount}`);
  // 旧实现：4 + ceil(len/4)，这里 len = ${text.length}
  const legacy = 4 + Math.ceil(text.length / 4);
  assert.ok(n > legacy, `中文估算 ${n} 必须高于旧实现 ${legacy}`);
});

test('estimateInputTokens: 中英混合结果高于等长纯英文（保守方向）', () => {
  const len = 40;
  const zh = '字'.repeat(len);
  const en = 'a'.repeat(len);
  const zhN = estimateInputTokens({ messages: [{ role: 'user', content: zh }] });
  const enN = estimateInputTokens({ messages: [{ role: 'user', content: en }] });
  assert.ok(zhN > enN, '同样长度下中文估算必须更保守');
});

test('estimateTextTokens: 非字符串输入返回 0', () => {
  assert.equal(estimateTextTokens(null), 0);
  assert.equal(estimateTextTokens(undefined), 0);
  assert.equal(estimateTextTokens(123), 0);
});
