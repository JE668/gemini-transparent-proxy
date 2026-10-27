// gemini-transparent-proxy/lib/openai-compat.js
//
// Google Gemini「OpenAI 兼容端点」的请求体清洗 + URL 映射。
//
// 本模块刻意保持「零依赖」：不 import 任何第三方包，也不 import 本项目其它模块。
// 这样单元测试可以直接 `import` 它，无需启动 Redis / Next.js 运行时。
//
// ⚠️ 本文件与 cloudflare-worker/src/index.js 中的同名逻辑是「同一份语义的两个副本」
//    （CF Worker 独立构建，无法直接 import 本目录）。修改任何一处都必须同步另一处，
//    否则两端行为分叉。tests/sync.test.js 会对两副本做一致性断言。

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
 *   /v1/chat/completions → /v1beta/openai/chat/completions
 *   /api/v1/...         → /v1beta/openai/...
 *   /api/...            → /v1beta/openai/...
 *   其它路径原样透传（原生 generateContent / embedContent 等）
 */
export function buildTargetUrl(pathname, search) {
  const rules = [
    { prefix: '/api/v1/', replacement: '/v1beta/openai/' },
    { prefix: '/v1/', replacement: '/v1beta/openai/' },
    { prefix: '/api/', replacement: '/v1beta/openai/' },
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
