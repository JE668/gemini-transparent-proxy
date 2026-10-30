// tests/version.test.mjs
//
// 版本号一致性守卫。
//
// ⚠️ 旧实现把版本号散落在三处且互相矛盾：
//   · package.json                     → "0.2.0"
//   · app/api/config/route.js          → '1.1.0-debug'
//   · app/api/[[...path]]/route.js     → '2.0.0'
// 用户从不同端点看到不同版本，无法判断线上跑的是哪一版。
//
// 现在统一由 lib/version.js 提供，本测试保证它与 package.json 始终一致，
// 且两端路由都从共享模块取值（不再内联字面量）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { APP_NAME, APP_VERSION } from '../lib/version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const configRouteSource = readFileSync(join(ROOT, 'app/api/config/route.js'), 'utf8');
const proxyRouteSource = readFileSync(join(ROOT, 'app/api/[[...path]]/route.js'), 'utf8');

test('lib/version.js 的版本号与 package.json 一致', () => {
  assert.equal(APP_VERSION, pkg.version,
    `lib/version.js (${APP_VERSION}) 与 package.json (${pkg.version}) 不一致 —— 请同时更新`);
});

test('版本号是合法 semver', () => {
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});

test('APP_NAME 非空', () => {
  assert.ok(typeof APP_NAME === 'string' && APP_NAME.length > 0);
});

test('两端路由都从 lib/version 引入版本号，不再内联字面量', () => {
  for (const [name, src] of [
    ['app/api/config/route.js', configRouteSource],
    ['app/api/[[...path]]/route.js', proxyRouteSource],
  ]) {
    assert.match(src, /import\s*\{[^}]*APP_VERSION[^}]*\}\s*from\s*'[^']*lib\/version'/,
      `${name} 必须从 lib/version 引入 APP_VERSION`);
    assert.ok(!/version:\s*['"]\d+\.\d+\.\d+[^'"]*['"]/.test(src),
      `${name} 不得再内联版本号字面量`);
  }
});
