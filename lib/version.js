// lib/version.js
//
// ⚠️ 应用版本号的唯一来源。
//
// 旧实现把版本号散落在三处且互相矛盾：
//   · package.json          → "0.2.0"
//   · app/api/config/route.js → version: '1.1.0-debug'
//   · app/api/[[...path]]/route.js → version: '2.0.0'
// 用户从不同端点看到不同版本，无法判断部署的是哪一版。
//
// 现在统一从这里取，tests/version.test.mjs 会断言它与 package.json 一致，
// 防止以后又漏改其中一处。

export const APP_NAME = 'Gemini Transparent Proxy';

/** 与 package.json 的 version 字段保持一致（由测试守护）。 */
export const APP_VERSION = '0.2.0';
