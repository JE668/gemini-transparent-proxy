// cloudflare-worker/src/responses.js
// CF Worker 端 Responses API 适配层（薄封装）
//
// ⚠️ 转换逻辑的唯一实现在 lib/responses-core.js：
//    Vercel 与 Cloudflare Worker 共用同一份，避免两边悄悄分叉。
//    本文件只负责「Redis 会话存储适配」——把 core 需要的 session 接口
//    用 CF 侧的 Upstash REST 实现出来。

import { fetchWithModelFallback } from '../../lib/upstream-retry.js';
import {
  newResponseId,
  responsesToChat,
  chatToResponses as chatToResponsesCore,
  streamResponses as streamResponsesCore,
  mergeHistoryMessages,
  sanitizeChatBody,
  sseEvent,
} from '../../lib/responses-core.js';
import {
  isAgentModel,
  responsesToInteraction,
  interactionToResponses,
  callInteractionsApi,
  getInteractionId,
} from './interactions.js';

export { newResponseId, responsesToChat, sanitizeChatBody, fetchWithModelFallback };

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';

// ── SessionStore (Upstash Redis REST) ────────────────────

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
  } catch {
    return null;
  }
}

async function sessionGetHistory(env, responseId) {
  const raw = await redisCmd(env, 'GET', `session:${responseId}`);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function sessionSave(env, responseId, messages) {
  await redisCmd(env, 'SET', `session:${responseId}`, JSON.stringify(messages), 'EX', 86400);
}

async function sessionStoreReasoning(env, callId, reasoning) {
  if (!reasoning || !callId) return;
  await redisCmd(env, 'SET', `reasoning:call:${callId}`, reasoning, 'EX', 86400);
}

async function sessionGetReasoning(env, callId) {
  return redisCmd(env, 'GET', `reasoning:call:${callId}`);
}

async function sessionStoreTurnReasoning(env, assistantMsg, reasoning) {
  if (!reasoning) return;
  const content = assistantMsg?.content;
  if (typeof content === 'string' && content && globalThis.crypto?.subtle) {
    const buf = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(content));
    const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    await redisCmd(env, 'SET', `reasoning:hash:${hash}`, reasoning, 'EX', 86400);
  }
  for (const tc of (assistantMsg?.tool_calls || [])) {
    if (tc?.id) await sessionStoreReasoning(env, tc.id, reasoning);
  }
}

/** core 需要的 session 适配器（CF 侧） */
function makeSession(env) {
  return {
    getHistory: (id) => sessionGetHistory(env, id),
    save: (id, messages) => sessionSave(env, id, messages),
    storeReasoning: (callId, reasoning) => sessionStoreReasoning(env, callId, reasoning),
    getReasoning: (callId) => sessionGetReasoning(env, callId),
    storeTurnReasoning: (msg, reasoning) => sessionStoreTurnReasoning(env, msg, reasoning),
  };
}

// ── Interactions AI 流式转 SSE ──

async function* streamFromInteractions(env, inBody, interactionBody, apiKey) {
  const respId = newResponseId();
  const model = inBody.model || '';

  const respReasoning = {};
  const reqReasoning = inBody.reasoning;
  if (typeof reqReasoning === 'object') {
    respReasoning.effort = reqReasoning?.effort || 'medium';
  }
  respReasoning.summary = 'detailed';

  yield sseEvent('response.created', {
    type: 'response.created',
    response: { id: respId, status: 'in_progress', model, reasoning: respReasoning },
  });

  try {
    const resp = await callInteractionsApi(interactionBody, apiKey);

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '{}');
      yield sseEvent('response.failed', {
        type: 'response.failed',
        response: {
          id: respId,
          status: 'failed',
          error: { code: String(resp.status), message: errBody.slice(0, 500) },
        },
      });
      return;
    }

    const data = await resp.json();
    const responseObj = interactionToResponses(env, data, inBody, respId);
    const msgItems = responseObj.output || [];

    const reasoningItem = msgItems.find(m => m.type === 'reasoning');
    if (reasoningItem) {
      const reasoningIndex = msgItems.indexOf(reasoningItem);
      yield sseEvent('response.output_item.added', {
        type: 'response.output_item.added', output_index: reasoningIndex,
        item: { type: 'reasoning', id: reasoningItem.id, summary: [] },
      });
      const summaryText = reasoningItem.summary?.[0]?.text || '';
      if (summaryText) {
        yield sseEvent('response.reasoning_summary_part.added', {
          type: 'response.reasoning_summary_part.added', item_id: reasoningItem.id,
          output_index: reasoningIndex, summary_index: 0, part: { type: 'summary_text', text: '' },
        });
        yield sseEvent('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta', item_id: reasoningItem.id,
          output_index: reasoningIndex, summary_index: 0, delta: summaryText,
        });
        yield sseEvent('response.reasoning_summary_text.done', {
          type: 'response.reasoning_summary_text.done', item_id: reasoningItem.id,
          output_index: reasoningIndex, summary_index: 0, text: summaryText,
        });
        yield sseEvent('response.reasoning_summary_part.done', {
          type: 'response.reasoning_summary_part.done', item_id: reasoningItem.id,
          output_index: reasoningIndex, summary_index: 0, part: { type: 'summary_text', text: summaryText },
        });
      }
      yield sseEvent('response.output_item.done', {
        type: 'response.output_item.done', output_index: reasoningIndex, item: reasoningItem,
      });
    }

    const msgItem = msgItems.find(m => m.type === 'message');
    if (msgItem) {
      const msgIndex = msgItems.indexOf(msgItem);
      yield sseEvent('response.output_item.added', {
        type: 'response.output_item.added', output_index: msgIndex,
        item: { type: 'message', id: msgItem.id, role: 'assistant', status: 'in_progress', content: [] },
      });
      const text = msgItem.content?.[0]?.text || '';
      if (text) {
        yield sseEvent('response.output_text.delta', {
          type: 'response.output_text.delta', item_id: msgItem.id,
          output_index: msgIndex, delta: text,
        });
      }
      yield sseEvent('response.output_item.done', {
        type: 'response.output_item.done', output_index: msgIndex, item: msgItem,
      });
    }

    yield sseEvent('response.completed', {
      type: 'response.completed', response: responseObj,
    });
  } catch (err) {
    yield sseEvent('response.failed', {
      type: 'response.failed',
      response: {
        id: respId,
        status: 'failed',
        error: { code: 'interactions_error', message: err.message || 'Interactions API call failed' },
      },
    });
  }
}

// ── 主处理入口 ────────────────────────────────────────────

export async function handleResponses(request, env) {
  const inBody = await request.json();
  const model = inBody.model || '';

  // 提取 API Key
  const authHeader = request.headers.get('authorization') || '';
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  // ── Agent 模型 → Interactions API ──
  if (isAgentModel(model)) {
    console.log(`Agent model detected: ${model} → routing to Interactions API`);

    let previousInteractionId = null;
    if (inBody.previous_response_id) {
      previousInteractionId = await getInteractionId(env, inBody.previous_response_id);
    }

    const interactionBody = responsesToInteraction(inBody);
    if (previousInteractionId) {
      interactionBody.previous_interaction_id = previousInteractionId;
    }

    if (inBody.stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      (async () => {
        try {
          for await (const sse of streamFromInteractions(env, inBody, interactionBody, apiKey)) {
            await writer.write(encoder.encode(sse));
          }
        } catch (err) {
          console.error(`Interactions stream error: ${err.message}`);
        } finally {
          await writer.close();
        }
      })();

      return new Response(readable, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // 非流式
    const resp = await callInteractionsApi(interactionBody, apiKey);

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '{}');
      return new Response(errBody, {
        status: resp.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await resp.json();
    const responseObj = interactionToResponses(env, data, inBody);

    return new Response(JSON.stringify(responseObj), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── 常规模型 → Chat Completions ──
  let historyMessages = [];
  if (inBody.previous_response_id) {
    historyMessages = await sessionGetHistory(env, inBody.previous_response_id);
  }

  const chatBody = responsesToChat(inBody);
  mergeHistoryMessages(chatBody, historyMessages);

  // 清理 Google 不支持的字段（两端共用同一份规则）
  const sanitizedChatBody = sanitizeChatBody(chatBody);

  if (inBody.stream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const fetchFn = async (url, opts) => {
      const headers = { ...opts.headers };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      return fetch(url, { ...opts, headers });
    };

    (async () => {
      try {
        for await (const sse of streamResponsesCore(inBody, sanitizedChatBody, fetchFn, makeSession(env))) {
          await writer.write(encoder.encode(sse));
        }
      } catch (err) {
        console.error(`Responses stream error: ${err.message}`);
        const errEvent = sseEvent('response.failed', {
          type: 'response.failed',
          response: {
            id: 'resp_error',
            status: 'failed',
            error: { code: 'internal_error', message: err.message || 'Unknown error' },
          },
        });
        await writer.write(encoder.encode(errEvent));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  return handleResponsesNonStream(env, inBody, sanitizedChatBody, apiKey);
}

async function handleResponsesNonStream(env, inBody, chatBody, apiKey) {
  const upstreamUrl = `${GOOGLE_API_BASE}/v1beta/openai/chat/completions`;
  // ⚠️ 上游 429/5xx 时按「同模型退避重试 → 模型降级」兜底（与聊天路径同一套策略）
  const upstreamFetch = async (url, opts) => {
    const headers = { ...opts.headers };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    return fetch(url, { ...opts, headers });
  };
  const { response: upstreamResp } = await fetchWithModelFallback({
    fetchFn: upstreamFetch,
    url: upstreamUrl,
    headers: { 'Content-Type': 'application/json' },
    body: chatBody,
    modelId: chatBody.model,
    onFallback: (from, to, status) => {
      console.log(`[Responses] Model fallback: ${from} → ${to} (${status})`);
    },
  });

  if (!upstreamResp.ok) {
    const errBody = await upstreamResp.text().catch(() => '{}');
    return new Response(errBody, {
      status: upstreamResp.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const data = await upstreamResp.json();
  const responseObj = await chatToResponsesCore(data, inBody, chatBody, makeSession(env));

  return new Response(JSON.stringify(responseObj), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeadersObj() },
  });
}

function corsHeadersObj() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
  };
}
