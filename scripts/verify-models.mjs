#!/usr/bin/env node
// 用 Google ListModels 接口验证 lib/models.js 目录里每个 id 是否真实可调用。
//
// 用法：
//   GOOGLE_API_KEY=xxx node scripts/verify-models.mjs
// 或：
//   node scripts/verify-models.mjs <API_KEY>
//
// 输出：目录里每个 id 与 Google 实际返回的 model name 逐条比对，
//      标出 ✅ 存在 / ❌ 不存在（并给出最接近的候选名）。

import { HIGH_QUOTA_MODELS } from '../lib/models.js';

const KEY = process.env.GOOGLE_API_KEY || process.argv[2];
if (!KEY) {
  console.error('缺少 API Key。用法: GOOGLE_API_KEY=xxx node scripts/verify-models.mjs');
  process.exit(1);
}

// 拉全量（ListModels 分页，pageSize 最大 1000）
async function listAll() {
  const names = [];
  let pageToken = '';
  do {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('key', KEY);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const r = await fetch(url);
    if (!r.ok) {
      console.error(`ListModels 失败: ${r.status} ${await r.text()}`);
      process.exit(1);
    }
    const j = await r.json();
    for (const m of (j.models || [])) names.push(m.name.replace(/^models\//, ''));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return names;
}

// 简单相似度：找最接近的候选（用于 ❌ 时给建议）
function closest(id, pool) {
  const base = id.replace(/-it$|-preview.*$|-exp$/g, '');
  return pool
    .filter(n => n.includes(base) || base.includes(n.replace(/-it$|-preview.*$/g, '')))
    .slice(0, 3);
}

const real = await listAll();
const realSet = new Set(real);
console.log(`Google 返回 ${real.length} 个模型\n`);

let ok = 0, bad = 0;
console.log('=== 目录逐条验证 ===');
for (const m of HIGH_QUOTA_MODELS) {
  if (realSet.has(m.id)) {
    console.log(`✅ ${m.id}`);
    ok++;
  } else {
    const cand = closest(m.id, real);
    console.log(`❌ ${m.id}${cand.length ? '   → 候选: ' + cand.join(', ') : '   (无相近候选)'}`);
    bad++;
  }
}

console.log(`\n结果: ${ok} 真实, ${bad} 不存在`);
console.log('\n=== Google 实际可用的 gemma / gemini 模型（供补录）===');
for (const n of real.filter(n => /^(gemma|gemini)/.test(n)).sort()) console.log('  ' + n);
