// gemini-transparent-proxy/lib/openai-compat.js
//
// Google Gemini「OpenAI 兼容端点」的请求体清洗 + URL 映射。
//
// 本模块刻意保持「零依赖」：不 import 任何第三方包，也不 import 本项目其它模块。
// 这样单元测试可以直接 `import` 它，无需启动 Redis / Next.js 运行时。
//
// ⚠️ 本模块是 Vercel 与 CF Worker 共用的「唯一」实现：两端都直接 `import` 本文件
//    （CF Worker 由 wrangler/esbuild 一并打包进产物），从根本上消除「两端各维护一份」的行为分叉。
//    tests/sync.test.mjs 会断言两端都从本模块引入，且各自文件内不得再内联副本。

export const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';

// Google OpenAI 兼容端点不接受的顶层字段（发了会 400 / 被忽略）
export const GOOGLE_OPENAI_BLOCKED = new Set([
  'stream_options', 'reasoning_effort', 'frequency_penalty', 'presence_penalty',
  'logit_bias', 'logprobs', 'top_logprobs', 'seed', 'user', 'service_tier',
  'n', 'include_reasoning', 'store', 'metadata', 'parallel_tool_calls', 'response_format',
]);

/**
 * 清洗 OpenAI 兼容请求体：
 *   1. 去掉 Google 不接受的顶层字段
 *   2. 去掉值为 null 的字段
 *   3. 递归清洗 tools[].function，只保留 name / description / parameters
 * 非 JSON body 原样透传。
 */
export function sanitizeOpenAIBody(body) {
  if (!body || body === '{}') return body;
  try {
    const json = JSON.parse(body);
    const cleaned = {};
    for (const key in json) {
      if (!GOOGLE_OPENAI_BLOCKED.has(key) && json[key] !== null) {
        cleaned[key] = json[key];
      }
    }
    // ⚠️ 递归清洗 tools[].function：只保留 name/description/parameters
    if (cleaned.tools && Array.isArray(cleaned.tools)) {
      cleaned.tools = cleanTools(cleaned.tools);
    }
    return JSON.stringify(cleaned);
  } catch (e) {
    // 非 JSON body 直接透传
    return body;
  }
}

/**
 * 清洗 tools 中的 function 对象，只保留 Google 认识的字段。
 * Hermes/Workbuddy 可能发 strict、type 等 OpenAI 特有字段，Google 不认识会 400。
 */
export function cleanTools(tools) {
  // 非数组直接原样返回（与 CF Worker 原内联实现一致，且避免 null.map 抛错）
  if (!tools || !Array.isArray(tools)) return tools;
  return tools.map(tool => {
    if (!tool || !tool.function) return tool;
    const cleaned = {};
    for (const key in tool) {
      if (key !== 'function') cleaned[key] = tool[key];
    }
    const fn = {};
    if (tool.function.name !== undefined) fn.name = tool.function.name;
    if (tool.function.description !== undefined) fn.description = tool.function.description;
    if (tool.function.parameters !== undefined) fn.parameters = tool.function.parameters;
    cleaned.function = fn;
    return cleaned;
  });
}

/**
 * 把客户端路径映射到 Google 上游路径。
 *   /v1/chat/completions  → /v1beta/openai/chat/completions
 *   /api/v1/chat/completions → /v1beta/openai/chat/completions
 *   /api/v1beta/models/{model}:predict       → /v1beta/models/{model}:predict        （原生透传）
 *   /api/v1beta/models/{model}:embedContent  → /v1beta/models/{model}:embedContent   （原生透传）
 *   /api/v1beta/models/{model}:generateContent → /v1beta/models/{model}:generateContent
 *   其它路径原样透传（原生 generateContent / embedContent 等）
 *
 * ⚠️ 规则顺序很重要：`/api/v1/` 必须排在 `/api/v1beta/` 之前，
 *    否则 `/api/v1beta/...` 会被误判成 OpenAI 兼容路径，
 *    产出 `/v1beta/openai/v1beta/models/...` 这种必然 404 的 URL。
 */
export function buildTargetUrl(pathname, search) {
  const rules = [
    { prefix: '/api/v1/', replacement: '/v1beta/openai/' },
    { prefix: '/v1/', replacement: '/v1beta/openai/' },
    { prefix: '/api/v1beta/', replacement: '/v1beta/' },
    { prefix: '/api/', replacement: '/v1beta/' },
  ];
  let targetPath = pathname;
  for (const { prefix, replacement } of rules) {
    if (targetPath.startsWith(prefix)) {
      targetPath = replacement + targetPath.slice(prefix.length);
      break;
    }
  }
  if (search) {
    return `${GOOGLE_API_BASE}${targetPath}${search}`;
  }
  return `${GOOGLE_API_BASE}${targetPath}`;
}

/**
 * 脱敏 URL：移除可能携带凭据的 query 参数（key / access_token / api_key ...）。
 *
 * ⚠️ 代理曾把 Google API Key 放进 URL query（`?key=xxx`），
 *    导致完整 Key 出现在 Vercel 日志与 /api/debug-last 回显中。
 *    现在鉴权统一走 `x-goog-api-key` header，但所有日志/调试输出仍统一过一遍本函数，
 *    作为「万一将来又有人把凭据写进 URL」的最后一道防线。
 */
export const SENSITIVE_QUERY_KEYS = ['key', 'api_key', 'apikey', 'access_token', 'token', 'authorization', 'password', 'secret'];

export function redactUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    let changed = false;
    for (const k of SENSITIVE_QUERY_KEYS) {
      if (u.searchParams.has(k)) {
        u.searchParams.set(k, 'REDACTED');
        changed = true;
      }
    }
    return changed ? u.toString() : url;
  } catch {
    // 不是合法 URL：退化为正则清洗
    return String(url).replace(/([?&](?:key|api_key|apikey|access_token|token|password|secret)=)[^&]*/gi, '$1REDACTED');
  }
}
