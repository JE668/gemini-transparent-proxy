// lib/interactions.js
// Gemini Interactions API ↔ Responses API 转换层
// 让 Codex 客户端通过现有 /v1/responses 端点接入 Deep Research 等代理模型
//
// Interactions API 文档: https://ai.google.dev/gemini-api/docs/interactions-overview?hl=zh-cn
// REST 端点: POST https://generativelanguage.googleapis.com/v1beta/interactions

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';

import { newResponseId } from './responses.js';
import { getRedis } from './redis.js';

// ── Agent 模型白名单 ──
// 这些模型不走 Chat Completions 兼容层，直接转发到 Interactions API
export const AGENT_MODELS = new Set([
  'deep-research-preview-04-2026',
  'deep-research-max-preview-04-2026',
  'antigravity-preview-05-2026',
]);

export function isAgentModel(model) {
  if (!model || typeof model !== 'string') return false;
  return AGENT_MODELS.has(model);
}

// ── Session ID 双向映射（Redis） ──
// Codex 用 previous_response_id → 映射到 Interactions API 的 previous_interaction_id
// 以便跨轮对话无缝衔接

async function getR() {
  return getRedis();
}

export async function saveInteractionMapping(responseId, interactionId) {
  const r = await getR();
  if (!r) return;
  const ttl = 86400;
  try {
    await r.set(`resp2inter:${responseId}`, interactionId);
    await r.expire(`resp2inter:${responseId}`, ttl);
    await r.set(`inter2resp:${interactionId}`, responseId);
    await r.expire(`inter2resp:${interactionId}`, ttl);
  } catch {}
}

export async function getInteractionId(responseId) {
  const r = await getR();
  if (!r) return null;
  try { return (await r.get(`resp2inter:${responseId}`)) || null; } catch { return null; }
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
export function interactionToResponses(interactionData, originalBody) {
  const respId = newResponseId();
  const interactionId = interactionData.id || '';

  // 存映射（fire-and-forget）
  if (interactionId) {
    saveInteractionMapping(respId, interactionId).catch(() => {});
  }

  const outputItems = [];
  const steps = interactionData.steps || [];

  let reasoningText = '';
  let outputText = '';

  for (const step of steps) {
    const type = step.type || '';
    if (type === 'model_thought' || type === 'thinking') {
      reasoningText += (step.content || step.text || '');
    } else if (type === 'function_call' || type === 'tool_call') {
      // tool_call 在非流式场景较少见，暂不处理
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

  // 构建 output items
  if (reasoningText) {
    outputItems.push({
      type: 'reasoning',
      id: `rs_${Math.random().toString(16).slice(2, 18)}`,
      summary: [{ type: 'summary_text', text: reasoningText }],
    });
  }

  if (outputText) {
    outputItems.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: outputText }],
    });
  }

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
