// cloudflare-worker/src/interactions.js
// Gemini Interactions API ↔ Responses API 转换层（CF Worker 版）
// 让 Codex 客户端通过 /v1/responses 端点接入 Deep Research 等代理模型
//
// REST: POST https://generativelanguage.googleapis.com/v1beta/interactions

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';

// ── Agent 模型白名单 ──
export const AGENT_MODELS = new Set([
  'deep-research-preview-04-2026',
  'deep-research-max-preview-04-2026',
  'antigravity-preview-05-2026',
]);

export function isAgentModel(model) {
  if (!model || typeof model !== 'string') return false;
  return AGENT_MODELS.has(model);
}

// ── Session 双向映射（Upstash Redis REST） ──
async function redisCmd(env, cmd, ...args) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return null;
  try {
    const resp = await fetch(env.UPSTASH_REDIS_REST_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([cmd, ...args]),
    });
    const data = await resp.json();
    return data.result;
  } catch { return null; }
}

export async function saveInteractionMapping(env, responseId, interactionId) {
  const ttl = 86400;
  await redisCmd(env, 'SET', `resp2inter:${responseId}`, interactionId, 'EX', ttl);
  await redisCmd(env, 'SET', `inter2resp:${interactionId}`, responseId, 'EX', ttl);
}

export async function getInteractionId(env, responseId) {
  return redisCmd(env, 'GET', `resp2inter:${responseId}`);
}

export function newResponseId() {
  return 'resp_' + Math.random().toString(16).slice(2, 14) + Date.now().toString(16).slice(-10);
}

// ── 请求转换: Responses API → Interactions API ──
export function responsesToInteraction(responsesBody) {
  const body = {};

  body.model = responsesBody.model;

  const instructions = responsesBody.instructions || responsesBody.system;
  if (instructions) body.system_instruction = instructions;

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
    }
    body.input = parts.join('\n');
  }

  if (responsesBody.tools && Array.isArray(responsesBody.tools)) {
    const cleaned = [];
    for (const t of responsesBody.tools) {
      const kind = t.type || '';
      if (kind === 'function') {
        const fn = {};
        const src = t.function || t;
        for (const k of ['name', 'description', 'parameters']) {
          if (k in src) fn[k] = src[k];
        }
        cleaned.push({ type: 'function', function: fn });
      } else if (kind === 'namespace') {
        for (const sub of (t.tools || [])) {
          if (sub.type === 'function') {
            const fn = {};
            const src = sub.function || sub;
            for (const k of ['name', 'description', 'parameters']) {
              if (k in src) fn[k] = src[k];
            }
            cleaned.push({ type: 'function', function: fn });
          }
        }
      }
    }
    if (cleaned.length > 0) body.tools = cleaned;
  }

  const gc = {};
  if (responsesBody.temperature !== undefined) gc.temperature = responsesBody.temperature;
  if (responsesBody.max_output_tokens !== undefined) gc.max_output_tokens = responsesBody.max_output_tokens;
  if (responsesBody.top_p !== undefined) gc.top_p = responsesBody.top_p;
  const effort = responsesBody.reasoning?.effort || '';
  if (effort === 'high') gc.thinking_level = 'VERBOSE';
  else if (effort === 'low') gc.thinking_level = 'NONE';
  else if (effort === 'medium') gc.thinking_level = 'BALANCED';
  if (Object.keys(gc).length > 0) body.generation_config = gc;

  if (responsesBody.store === false || responsesBody.disable_response_storage === true) {
    body.store = false;
  }

  if (responsesBody.background === true) {
    body.background = true;
  }

  return body;
}

// ── 响应转换: Interactions API → Responses API ──
export function interactionToResponses(interactionData, originalBody) {
  const respId = newResponseId();
  const outputItems = [];
  const steps = interactionData.steps || [];

  let reasoningText = '';
  let outputText = '';

  for (const step of steps) {
    const type = step.type || '';
    if (type === 'model_thought' || type === 'thinking') {
      reasoningText += (step.content || step.text || '');
    } else if (type === 'model_output' || type === 'output') {
      outputText += (step.content || step.text || '');
    } else if (type === 'model_thought_and_output') {
      reasoningText += (step.thinking || step.reasoning || '');
      outputText += (step.output || step.content || step.text || '');
    }
  }

  if (!outputText && interactionData.output_text) {
    outputText = interactionData.output_text;
  }

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
export async function callInteractionsApi(body, apiKey) {
  const url = `${GOOGLE_API_BASE}/v1beta/interactions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-goog-api-key'] = apiKey;

  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}
