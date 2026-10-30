// lib/interactions-core.js
// Gemini Interactions API ↔ Responses API 转换层的**唯一实现**（Vercel 与 Cloudflare Worker 共用）
//
// ⚠️ 背景：此前 lib/interactions.js（240 行）与 cloudflare-worker/src/interactions.js（206 行）
//    各维护一份几乎相同的转换逻辑。两者对 tool_call 步骤的处理还不一致：
//    Vercel 版识别 'function_call' / 'tool_call'，CF 版直接忽略。
//    现在把纯转换逻辑收敛到本模块，两端只保留 Redis 访问方式的差异。
//
// Redis 会话映射（resp2inter / inter2resp）通过注入的 interactionStore 处理：
//   { save(responseId, interactionId): Promise<void>
//     get(responseId): Promise<string|null> }

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';

// ── Agent 模型白名单 ──
// 这些模型不走 Chat Completions 兼容层，直接转发到 Interactions API
// （deep-research 系列 2026-10-25 快照免费层配额归零 0/0/0，已移除；仅保留 Antigravity）
export const AGENT_MODELS = new Set([
  'antigravity-preview-05-2026',
]);

export function isAgentModel(model) {
  if (!model || typeof model !== 'string') return false;
  return AGENT_MODELS.has(model);
}

// ── 请求转换: Responses API → Interactions API ──
export function responsesToInteraction(responsesBody) {
  const body = {};

  // --- model ---
  body.model = responsesBody.model;

  // --- system_instruction ---
  const instructions = responsesBody.instructions || responsesBody.system;
  if (instructions) {
    body.system_instruction = instructions;
  }

  // --- input ---
  // Interactions API 接受字符串或 items 数组
  const inputItems = responsesBody.input || [];
  if (typeof inputItems === 'string') {
    body.input = inputItems;
  } else if (Array.isArray(inputItems)) {
    const parts = [];
    for (const item of inputItems) {
      if (item.type === 'message' && item.role === 'user') {
        const content = item.content;
        if (typeof content === 'string') {
          parts.push(content);
        } else if (Array.isArray(content)) {
          for (const p of content) {
            if (['input_text', 'text', 'output_text'].includes(p.type || '')) {
              parts.push(p.text || '');
            } else if (p.type === 'input_image') {
              parts.push('[图片]');
            }
          }
        }
      }
      // function_call_output → 靠 previous_interaction_id 处理
    }
    body.input = parts.join('\n');
  }

  // --- tools ---
  if (responsesBody.tools && Array.isArray(responsesBody.tools)) {
    const cleaned = [];
    for (const t of responsesBody.tools) {
      const kind = t.type || '';
      if (kind === 'function') {
        const srcFn = t.function || t;
        const fn = {};
        for (const k of ['name', 'description', 'parameters']) {
          if (k in srcFn) fn[k] = srcFn[k];
        }
        cleaned.push({ type: 'function', function: fn });
      } else if (kind === 'namespace') {
        for (const sub of (t.tools || [])) {
          if (sub.type === 'function') {
            const srcFn = sub.function || sub;
            const fn = {};
            for (const k of ['name', 'description', 'parameters']) {
              if (k in srcFn) fn[k] = srcFn[k];
            }
            cleaned.push({ type: 'function', function: fn });
          }
        }
      }
    }
    if (cleaned.length > 0) body.tools = cleaned;
  }

  // --- generation_config ---
  const gc = {};
  if (responsesBody.temperature !== undefined) gc.temperature = responsesBody.temperature;
  if (responsesBody.max_output_tokens !== undefined) gc.max_output_tokens = responsesBody.max_output_tokens;
  if (responsesBody.top_p !== undefined) gc.top_p = responsesBody.top_p;
  // reasoning.effort → thinking_level
  const effort = responsesBody.reasoning?.effort || '';
  if (effort === 'high') gc.thinking_level = 'VERBOSE';
  else if (effort === 'low') gc.thinking_level = 'NONE';
  else if (effort === 'medium') gc.thinking_level = 'BALANCED';
  if (Object.keys(gc).length > 0) body.generation_config = gc;

  // --- previous_interaction_id ---
  // 由调用方在运行时注入（因为需要 await 查 Redis）
  // 见 handleResponsesApi 中调用前设置

  // --- store ---
  if (responsesBody.store === false || responsesBody.disable_response_storage === true) {
    body.store = false;
  }

  // --- background ---
  if (responsesBody.background === true) {
    body.background = true;
  }

  return body;
}

// ── 响应转换: Interactions API → Responses API ──
export function interactionToResponses(interactionData, originalBody, responseId) {
  const respId = responseId || ('resp_' + Math.random().toString(16).slice(2, 14) + Date.now().toString(16).slice(-10));
  const interactionId = interactionData.id || '';

  const outputItems = [];
  const steps = interactionData.steps || [];

  let reasoningText = '';
  let outputText = '';

  for (const step of steps) {
    const type = step.type || '';
    if (type === 'model_thought' || type === 'thinking') {
      reasoningText += (step.content || step.text || '');
    } else if (type === 'function_call' || type === 'tool_call') {
      // 工具调用在 Interactions API 中以 step 形式返回，
      // 转换为 Responses API 的 function_call output item。
      const fn = step.function || step;
      outputItems.push({
        type: 'function_call',
        call_id: step.call_id || step.id || '',
        name: fn.name || '',
        arguments: typeof fn.arguments === 'string'
          ? fn.arguments
          : (fn.arguments ? JSON.stringify(fn.arguments) : ''),
      });
    } else if (type === 'model_output' || type === 'output') {
      outputText += (step.content || step.text || '');
    } else if (type === 'model_thought_and_output') {
      reasoningText += (step.thinking || step.reasoning || '');
      outputText += (step.output || step.content || step.text || '');
    }
  }

  // fallback: output_text 顶层字段
  if (!outputText && interactionData.output_text) {
    outputText = interactionData.output_text;
  }

  // 构建 output items（reasoning / message 需插在 function_call 之前）
  const headItems = [];
  if (reasoningText) {
    headItems.push({
      type: 'reasoning',
      id: `rs_${Math.random().toString(16).slice(2, 18)}`,
      summary: [{ type: 'summary_text', text: reasoningText }],
    });
  }
  if (outputText) {
    headItems.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: outputText }],
    });
  }
  outputItems.unshift(...headItems);

  // reasoning echo
  const respReasoning = {};
  if (typeof originalBody.reasoning === 'object') {
    respReasoning.effort = originalBody.reasoning?.effort || 'medium';
  }
  respReasoning.summary = reasoningText ? 'detailed' : 'omitted';

  return {
    id: respId,
    object: 'response',
    model: originalBody.model || '',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    reasoning: respReasoning,
    output: outputItems,
    usage: interactionData.usage ? {
      input_tokens: interactionData.usage.input_tokens || 0,
      output_tokens: interactionData.usage.output_tokens || 0,
      total_tokens: interactionData.usage.total_tokens || 0,
    } : null,
    // 供调用方建立 resp2inter 映射（不直接写 Redis，避免耦合存储实现）
    _interactionId: interactionId,
  };
}

// ── 调用 Interactions API ──
// 返回原生 Response 对象（调用方决定读 body / stream）
export async function callInteractionsApi(interactionBody, apiKey) {
  const url = `${GOOGLE_API_BASE}/v1beta/interactions`;
  const headers = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey;
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(interactionBody),
  });
  return resp;
}
