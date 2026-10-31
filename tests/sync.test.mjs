// tests/sync.test.mjs
//
// 「双份维护」一致性守卫。
//
// 本项目有两套部署目标：
//   Vercel    (lib/ + app/api/[[...path]]/route.js)
//   CF Worker (cloudflare-worker/src/*)
// 历史上真正的线上事故都来自这两边悄悄分叉（模型顺序、TPM 上限、降级链）。
//
// 现在的策略是「能共享的一律共享」：
//   模型目录 / TPM 额度 / token 估算 / 请求体清洗 / 降级链 全部只有 lib/ 一份，
//   CF Worker 通过 import 复用（wrangler/esbuild 会打进产物）。
// 所以本测试的职责从「比对两份副本」变成了「防止副本重新出现」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { HIGH_QUOTA_MODELS } from '../lib/models.js';
import { TPM_LIMITS } from '../lib/token-limit.js';
import { MODEL_FALLBACKS } from '../lib/model-fallbacks.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CF_INDEX = join(ROOT, 'cloudflare-worker/src/index.js');
const VERCEL_ROUTE = join(ROOT, 'app/api/[[...path]]/route.js');

const cfSource = readFileSync(CF_INDEX, 'utf8');
const routeSource = readFileSync(VERCEL_ROUTE, 'utf8');
const responsesSource = readFileSync(join(ROOT, 'lib/responses.js'), 'utf8');
const responsesCoreSource = readFileSync(join(ROOT, 'lib/responses-core.js'), 'utf8');
const libInteractionsSource = readFileSync(join(ROOT, 'lib/interactions.js'), 'utf8');
const handlerSource = readFileSync(join(ROOT, 'lib/responses-handler.js'), 'utf8');
const cfResponsesSource = readFileSync(join(ROOT, 'cloudflare-worker/src/responses.js'), 'utf8');
const cfInteractionsSource = readFileSync(join(ROOT, 'cloudflare-worker/src/interactions.js'), 'utf8');

// ── 1. 共享模块：CF Worker 必须 import，不得再内联一份副本 ──

test('CF Worker 复用 lib/models.js 的模型目录（不再内联副本）', () => {
  assert.match(cfSource, /import\s*\{[^}]*HIGH_QUOTA_MODELS[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/models\.js'/,
    'CF Worker 必须从 lib/models.js 引入 HIGH_QUOTA_MODELS');
  assert.ok(!/const\s+MODELS\s*=\s*\{[^}]*data\s*:\s*\[/s.test(cfSource),
    'CF Worker 不得再内联模型数组副本');
  assert.match(cfSource, /data:\s*HIGH_QUOTA_MODELS/,
    'MODELS.data 应直接引用 HIGH_QUOTA_MODELS');
});

test('CF Worker 复用 lib/token-limit.js 的 TPM 额度与 token 估算', () => {
  assert.match(cfSource, /import\s*\{[^}]*TPM_LIMITS[^}]*estimateInputTokens[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/token-limit\.js'/,
    'CF Worker 必须从 lib/token-limit.js 引入 TPM_LIMITS 与 estimateInputTokens');
  assert.ok(!/const\s+TPM_LIMITS\s*=\s*\{/.test(cfSource), 'CF Worker 不得再内联 TPM_LIMITS 副本');
  assert.ok(!/function\s+estimateInputTokens\s*\(/.test(cfSource),
    'CF Worker 不得再内联 estimateInputTokens 副本');
});

test('CF Worker 复用 lib/openai-compat.js 的请求体清洗与 URL 映射', () => {
  assert.match(cfSource, /import\s*\{[^}]*sanitizeOpenAIBody[^}]*buildTargetUrl[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/openai-compat\.js'/,
    'CF Worker 必须从 lib/openai-compat.js 引入 sanitizeOpenAIBody 与 buildTargetUrl');
  assert.ok(!/function\s+cleanTools\s*\(/.test(cfSource), 'CF Worker 不得再内联 cleanTools 副本');
  assert.ok(!/const\s+GOOGLE_OPENAI_BLOCKED\s*=\s*new\s+Set/.test(cfSource), 'CF Worker 不得再内联黑名单副本');
  assert.ok(!/function\s+sanitizeOpenAIBodyStrict\s*\(/.test(cfSource), 'CF Worker 不得再内联 sanitizeOpenAIBodyStrict 副本');
  assert.ok(!/function\s+buildTargetUrl\s*\(/.test(cfSource), 'CF Worker 不得再内联 buildTargetUrl 副本');
});

test('Vercel 端同样复用 lib/ 下的共享模块', () => {
  assert.match(routeSource, /from\s*'\.\.\/\.\.\/\.\.\/lib\/openai-compat'/, 'route.js 应引入 openai-compat');
  assert.match(routeSource, /from\s*'\.\.\/\.\.\/\.\.\/lib\/rate-limit'/, 'route.js 应引入 rate-limit');
  assert.ok(!/function\s+cleanTools\s*\(/.test(routeSource), 'route.js 不得再内联 cleanTools 副本');
  assert.ok(!/function\s+buildTargetUrl\s*\(/.test(routeSource), 'route.js 不得再内联 buildTargetUrl 副本');
});

// ── 2. 共享数据自身的正确性 ──

test('模型目录：无重复 id，且 id 非空', () => {
  const ids = HIGH_QUOTA_MODELS.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length, '模型目录存在重复 id');
  for (const id of ids) assert.ok(id && typeof id === 'string', '模型 id 必须是非空字符串');
});

test('模型目录：每个模型都带 limit 与 description（/v1/models 对外契约）', () => {
  for (const m of HIGH_QUOTA_MODELS) {
    assert.ok(typeof m.limit === 'number' && m.limit > 0, `${m.id} 缺少有效 limit`);
    assert.ok(typeof m.description === 'string' && m.description.length > 0, `${m.id} 缺少 description`);
    assert.equal(m.object, 'model');
    assert.equal(m.owned_by, 'google');
  }
});

test('TPM_LIMITS：目录里的每个模型都有对应额度（漏配会让限流静默失效）', () => {
  for (const m of HIGH_QUOTA_MODELS) {
    assert.ok(TPM_LIMITS[m.id] > 0, `模型 ${m.id} 未在 TPM_LIMITS 中配置`);
  }
});

// ── 3. 模型降级链：同样是共享模块，不得再有副本 ──

test('Vercel 与 CF Worker 都复用 lib/model-fallbacks.js 的降级链', () => {
  assert.match(routeSource, /import\s*\{[^}]*MODEL_FALLBACKS[^}]*\}\s*from\s*'\.\.\/\.\.\/\.\.\/lib\/model-fallbacks'/,
    'route.js 必须从 lib/model-fallbacks 引入 MODEL_FALLBACKS');
  assert.match(cfSource, /import\s*\{[^}]*MODEL_FALLBACKS[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/model-fallbacks\.js'/,
    'CF Worker 必须从 lib/model-fallbacks 引入 MODEL_FALLBACKS');
  assert.ok(!/const\s+MODEL_FALLBACKS\s*=\s*\{/.test(routeSource), 'route.js 不得再内联降级链副本');
  assert.ok(!/const\s+MODEL_FALLBACKS\s*=\s*\{/.test(cfSource), 'CF Worker 不得再内联降级链副本');
});

test('MODEL_FALLBACKS：每个降级目标都在模型目录内（否则降级后必然 404）', () => {
  const known = new Set(HIGH_QUOTA_MODELS.map(m => m.id));
  for (const [from, to] of Object.entries(MODEL_FALLBACKS)) {
    assert.ok(known.has(from), `降级链的源模型 ${from} 不在目录中`);
    assert.ok(known.has(to), `降级目标 ${to} 不在目录中`);
  }
});

test('MODEL_FALLBACKS：不存在自环（否则重试同一个模型毫无意义）', () => {
  for (const [from, to] of Object.entries(MODEL_FALLBACKS)) {
    assert.notEqual(from, to, `${from} 的降级目标是它自己`);
  }
});

// ── 4. 限流归属维度：两端必须一致（按 API Key 指纹，不能按客户端 IP）──
//
// ⚠️ 历史上 CF 端按 IP 计量、Vercel 端按 Key 指纹计量：
//    同一批用户切到 CF 就拿到了另一份额度，换 IP 也能绕过 TPM 墙。

test('两端限流归属维度一致：都按 API Key 指纹，不按客户端 IP', () => {
  assert.match(cfSource, /resolveRateLimitSubject/,
    'CF Worker 必须使用共享的 resolveRateLimitSubject 解析限流归属主体');
  assert.match(cfSource, /computeClientFingerprint/,
    'CF Worker 必须使用共享的 computeClientFingerprint 计算 Key 指纹');

  // 限流检查点必须以归属主体为键，而不是 clientIP
  assert.ok(!/rateLimiter\.check\(clientIP\)/.test(cfSource),
    'CF Worker 不得再按 clientIP 做 RPM 限流');
  assert.ok(!/tokenRateLimiter\.check\(modelId,\s*clientIP/.test(cfSource),
    'CF Worker 不得再按 clientIP 做 TPM 限流');
});

test('两端 RPM 上限一致：共用 parseRpmLimit，默认 60', async () => {
  const { parseRpmLimit, DEFAULT_RPM_LIMIT } = await import('../lib/rate-limit.js');
  assert.equal(DEFAULT_RPM_LIMIT, 60);
  assert.equal(parseRpmLimit(undefined), 60);
  assert.equal(parseRpmLimit('30'), 30);
  assert.equal(parseRpmLimit('0'), 0, '0 必须表示关闭限流');
  assert.match(cfSource, /parseRpmLimit\(env\.RATE_LIMIT_RPM\)/,
    'CF Worker 必须用共享的 parseRpmLimit 解析 RATE_LIMIT_RPM');
});

test('resolveRateLimitSubject: anon / 空值 → null（不限流）', async () => {
  const { resolveRateLimitSubject } = await import('../lib/rate-limit.js');
  assert.equal(resolveRateLimitSubject('anon'), null);
  assert.equal(resolveRateLimitSubject(''), null);
  assert.equal(resolveRateLimitSubject(null), null);
  assert.equal(resolveRateLimitSubject('abcdef12'), 'fp:abcdef12');
});

test('Responses 路径两端都接入了重试 / 降级', () => {
  // ⚠️ 转换逻辑已收敛到 lib/responses-core.js（两端共用同一份）。
  //    两端适配层只需 import 该模块即可继承重试/降级能力。
  for (const [name, src, importRe] of [
    ['lib/responses-core.js', responsesCoreSource, /from\s*'\.\/upstream-retry\.js'/],
    ['lib/responses.js', responsesSource, /from\s*'\.\/responses-core\.js'/],
    ['lib/responses-handler.js', handlerSource, /from\s*'\.\/upstream-retry\.js'/],
    ['CF responses.js', cfResponsesSource, /from\s*'\.\.\/\.\.\/lib\/responses-core\.js'/],
  ]) {
    assert.match(src, importRe, `${name} 必须引入 upstream-retry / responses-core`);
  }

  // 核心实现里必须真正调用了 fetchWithModelFallback
  assert.ok(responsesCoreSource.includes('fetchWithModelFallback({'),
    'lib/responses-core.js 未接入 fetchWithModelFallback（Responses 路径仍会因上游限流直接失败）');
  assert.ok(cfResponsesSource.includes('fetchWithModelFallback({'),
    'CF responses.js 未接入 fetchWithModelFallback');
});

test('Responses / Interactions 转换逻辑不得再出现双份实现', () => {
  // 旧的 800+ 行副本已被 lib/responses-core.js 取代，
  // 两端只保留「Redis 会话存储适配」，不再各写一份转换逻辑。
  for (const [name, src] of [
    ['lib/responses.js', responsesSource],
    ['CF responses.js', cfResponsesSource],
  ]) {
    assert.ok(!/function\s+responsesToChat\s*\(/.test(src),
      `${name} 不得再内联 responsesToChat 副本（应复用 lib/responses-core.js）`);
    assert.ok(!/function\s+convertUsage\s*\(/.test(src),
      `${name} 不得再内联 convertUsage 副本`);
    assert.ok(!/function\s+valueToChatContent\s*\(/.test(src),
      `${name} 不得再内联 valueToChatContent 副本`);
    assert.ok(src.length < 20000,
      `${name} 仍过大，转换逻辑可能没有完全收敛到 lib/responses-core.js`);
  }

  for (const [name, src] of [
    ['lib/interactions.js', libInteractionsSource],
    ['CF interactions.js', cfInteractionsSource],
  ]) {
    // ⚠️ 适配层允许有一个薄包装（负责建立 Redis 映射），
    //    但不得再内联 core 的转换主体（step 解析 / generation_config 组装等）。
    assert.ok(!/system_instruction/.test(src),
      `${name} 不得再内联 responsesToInteraction 副本（应复用 lib/interactions-core.js）`);
    assert.ok(!/thinking_level/.test(src),
      `${name} 不得再内联 responsesToInteraction 副本（应复用 lib/interactions-core.js）`);
    assert.ok(!/model_thought_and_output/.test(src),
      `${name} 不得再内联 interactionToResponses 副本（应复用 lib/interactions-core.js）`);
  }
});

// ── 4. 限流覆盖范围守卫：提前 return 的端点也必须限流 ──

test('Vercel：/v1/responses 与 /v1/interactions 分支都调用了 enforceRateLimits', () => {
  assert.ok(routeSource.includes('async function enforceRateLimits('),
    'route.js 必须定义 enforceRateLimits');
  const responsesIdx = routeSource.indexOf("pathname === '/v1/responses'");
  const interactionsIdx = routeSource.indexOf("pathname === '/v1/interactions'");
  assert.ok(responsesIdx > 0 && interactionsIdx > 0, '未找到对应的端点分支');

  for (const [name, idx] of [['responses', responsesIdx], ['interactions', interactionsIdx]]) {
    const window = routeSource.slice(idx, idx + 1400);
    assert.ok(window.includes('enforceRateLimits('),
      `${name} 分支未接入限流（提前 return 会绕过通用限流逻辑）`);
    assert.ok(window.includes('if (limited) return limited;'),
      `${name} 分支未处理限流拒绝结果`);
  }
});

test('CF Worker：/v1/responses 与 /v1/interactions 分支都调用了 enforceRateLimits', () => {
  assert.ok(cfSource.includes('function enforceRateLimits('), 'CF Worker 必须定义 enforceRateLimits');
  const responsesIdx = cfSource.indexOf("pathname === '/v1/responses'");
  const interactionsIdx = cfSource.indexOf("pathname === '/v1/interactions'");
  assert.ok(responsesIdx > 0 && interactionsIdx > 0, '未找到对应的端点分支');

  for (const [name, idx] of [['responses', responsesIdx], ['interactions', interactionsIdx]]) {
    const window = cfSource.slice(idx, idx + 1400);
    assert.ok(window.includes('enforceRateLimits('),
      `${name} 分支未接入限流（提前 return 会绕过通用限流逻辑）`);
    assert.ok(window.includes('if (limited) {'),
      `${name} 分支未处理限流拒绝结果`);
  }
});

test('CF Worker：读取限流用 body 时使用 clone()（避免消费掉下游需要的请求体）', () => {
  const idx = cfSource.indexOf("pathname === '/v1/responses'");
  const window = cfSource.slice(idx, idx + 1400);
  assert.ok(window.includes('request.clone().json()'),
    '必须用 request.clone().json() 读取 body，否则 handleResponses 会拿不到请求体');
});
