// tests/auth.test.mjs
//
// 鉴权模块回归测试。
//
// ⚠️ 这两个模块是 P0 安全修复的核心（默认不再放行、/v1/models 必须带 Key），
//    但此前完全没有测试覆盖 —— 任何一次「顺手清理」都可能把防线改回去。
//
//   lib/auth.js         → Dashboard API 的 Bearer 密码校验（/api/*）
//   lib/client-auth.js  → 代理 API Key 的提取与存在性校验（/v1/models 等）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getAuthMode,
  isDashboardAuthed,
  unauthorizedResponse,
  AUTH_MODE_DISABLED,
  AUTH_MODE_ENABLED,
  AUTH_MODE_MISCONFIGURED,
} from '../lib/auth.js';

import {
  extractBearerToken,
  hasApiKey,
  missingApiKeyResponse,
} from '../lib/client-auth.js';

// ── 工具 ──

/** 构造一个只提供 headers.get() 的最小 Request 替身。 */
function fakeReq(authorization) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return { headers };
}

/** 在受控的环境变量快照下执行 fn，结束后恢复。 */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── lib/client-auth.js ──

test('extractBearerToken: 提取 Bearer token', () => {
  assert.equal(extractBearerToken(fakeReq('Bearer sk-abc123')), 'sk-abc123');
  assert.equal(extractBearerToken(fakeReq('bearer sk-abc123')), 'sk-abc123',
    'bearer 前缀必须大小写不敏感');
  assert.equal(extractBearerToken(fakeReq('Bearer   sk-abc  ')), 'sk-abc',
    '多余空白必须被裁掉');
});

test('extractBearerToken: 无 header / 非 Bearer 格式 → 空字符串', () => {
  assert.equal(extractBearerToken(fakeReq(undefined)), '');
  assert.equal(extractBearerToken(fakeReq('')), '');
  assert.equal(extractBearerToken(fakeReq('Basic dXNlcjpwYXNz')), '');
  assert.equal(extractBearerToken({}), '');
  assert.equal(extractBearerToken(null), '');
});

test('hasApiKey: 只看凭据是否存在，不校验其有效性', () => {
  assert.equal(hasApiKey(fakeReq('Bearer sk-abc')), true);
  assert.equal(hasApiKey(fakeReq('Bearer ')), false);
  assert.equal(hasApiKey(fakeReq(undefined)), false);
});

test('missingApiKeyResponse: 401 + 结构化错误体', async () => {
  const res = missingApiKeyResponse();
  assert.equal(res.status, 401);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.equal(body.error.code, 'missing_api_key');
  assert.equal(body.error.type, 'invalid_request_error');
  assert.ok(body.error.message.includes('Authorization: Bearer'));
});

// ── lib/auth.js：认证模式判定 ──

test('getAuthMode: 已配置密码 → enabled', () => {
  withEnv({ DASHBOARD_PASSWORD: 'secret', NODE_ENV: 'production' }, () => {
    assert.equal(getAuthMode(), AUTH_MODE_ENABLED);
  });
});

test('getAuthMode: 生产环境未配置密码 → misconfigured（不得默认放行）', () => {
  withEnv({ DASHBOARD_PASSWORD: undefined, NODE_ENV: 'production', VERCEL: undefined, VERCEL_ENV: undefined }, () => {
    assert.equal(getAuthMode(), AUTH_MODE_MISCONFIGURED);
  });
});

test('getAuthMode: Vercel 线上环境即使 NODE_ENV 未设也视为生产', () => {
  withEnv({ DASHBOARD_PASSWORD: undefined, NODE_ENV: undefined, VERCEL: '1', VERCEL_ENV: undefined }, () => {
    assert.equal(getAuthMode(), AUTH_MODE_MISCONFIGURED);
  });
  withEnv({ DASHBOARD_PASSWORD: undefined, NODE_ENV: undefined, VERCEL: undefined, VERCEL_ENV: 'production' }, () => {
    assert.equal(getAuthMode(), AUTH_MODE_MISCONFIGURED);
  });
});

test('getAuthMode: 开发环境未配置密码 → disabled（本地开发放行）', () => {
  withEnv({ DASHBOARD_PASSWORD: undefined, NODE_ENV: 'development', VERCEL: undefined, VERCEL_ENV: undefined }, () => {
    assert.equal(getAuthMode(), AUTH_MODE_DISABLED);
  });
});

// ── lib/auth.js：请求校验 ──

test('isDashboardAuthed: 生产环境未配置密码 → 一律拒绝', () => {
  withEnv({ DASHBOARD_PASSWORD: undefined, NODE_ENV: 'production', VERCEL: undefined, VERCEL_ENV: undefined }, () => {
    assert.equal(isDashboardAuthed(fakeReq('Bearer anything')), false);
    assert.equal(isDashboardAuthed(fakeReq(undefined)), false);
  });
});

test('isDashboardAuthed: 密码正确 → 放行', () => {
  withEnv({ DASHBOARD_PASSWORD: 'correct-horse', NODE_ENV: 'production' }, () => {
    assert.equal(isDashboardAuthed(fakeReq('Bearer correct-horse')), true);
    assert.equal(isDashboardAuthed(fakeReq('bearer correct-horse')), true);
  });
});

test('isDashboardAuthed: 密码错误 / 缺失 / 头部格式错误 → 拒绝', () => {
  withEnv({ DASHBOARD_PASSWORD: 'correct-horse', NODE_ENV: 'production' }, () => {
    assert.equal(isDashboardAuthed(fakeReq('Bearer wrong')), false);
    assert.equal(isDashboardAuthed(fakeReq(undefined)), false);
    assert.equal(isDashboardAuthed(fakeReq('Basic abc')), false);
    // 前缀正确但密码是另一个密码的一部分 → 仍须拒绝
    assert.equal(isDashboardAuthed(fakeReq('Bearer correct-horse-extra')), false);
  });
});

test('isDashboardAuthed: 开发环境未配置密码 → 放行（仅本地）', () => {
  withEnv({ DASHBOARD_PASSWORD: undefined, NODE_ENV: 'development', VERCEL: undefined, VERCEL_ENV: undefined }, () => {
    assert.equal(isDashboardAuthed(fakeReq(undefined)), true);
  });
});

// ── lib/auth.js：响应 ──

test('unauthorizedResponse: 生产未配置密码 → 503（提示配置缺失）', async () => {
  const res = await withEnv(
    { DASHBOARD_PASSWORD: undefined, NODE_ENV: 'production', VERCEL: undefined, VERCEL_ENV: undefined },
    () => unauthorizedResponse(),
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, 'error');
  assert.ok(body.message.includes('DASHBOARD_PASSWORD'));
});

test('unauthorizedResponse: 已配置密码但未授权 → 401', async () => {
  const res = await withEnv(
    { DASHBOARD_PASSWORD: 'correct-horse', NODE_ENV: 'production' },
    () => unauthorizedResponse(),
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.status, 'error');
  assert.ok(body.message.includes('未授权'));
});
