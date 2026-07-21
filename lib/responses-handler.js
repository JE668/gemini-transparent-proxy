// lib/responses-handler.js
// Vercel 端 Responses API 处理入口
// 被 app/api/[[...path]]/route.js 调用，处理 /v1/responses 请求
//
// 增强: 自动识别 agent 模型（Deep Research、Antigravity 等），
// 不走 Chat Completions 兼容层，直连 Interactions API

import {
  responsesToChat,
  chatToResponses,
  streamResponses,
  sessionGetHistory,
  sessionStoreReasoning,
  sessionSave,
  newResponseId,
} from './responses.js';
import {
  isAgentModel,
  responsesToInteraction,
  interactionToResponses,
  callInteractionsApi,
  getInteractionId,
} from './interactions.js';

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';

const GOOGLE_OPENAI_BLOCKED = new Set([
  'stream_options', 'reasoning_effort', 'frequency_penalty', 'presence_penalty',
  'logit_bias', 'logprobs', 'top_logprobs', 'seed', 'user', 'service_tier',
  'n', 'include_reasoning', 'store', 'metadata', 'parallel_tool_calls', 'response_format',
]);

function sanitizeChatBody(body) {
  const cleaned = { ...body };
  for (const key of Object.keys(cleaned)) {
    if (GOOGLE_OPENAI_BLOCKED.has(key) || cleaned[key] === null) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

function getCors(req) {
  const allowed = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin') || '';
  let allow = '*';
  if (allowed.length > 0 && origin) {
    allow = allowed.includes(origin) ? origin : allowed[0];
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

// ── Interactions API 流式转 Responses API SSE ──
// Interactions API 当前不支持 stream=true，
// 用非流式取完后，构造成 Responses API 标准 SSE 事件序列
async function* streamFromInteractions(inBody, interactionBody, apiKey) {
  const respId = newResponseId();
  const model = inBody.model || '';

  const respReasoning = {};
  const reqReasoning = inBody.reasoning;
  if (typeof reqReasoning === 'object') {
    respReasoning.effort = reqReasoning?.effort || 'medium';
  }
  respReasoning.summary = 'detailed';

  function sse(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  // response.created
  yield sse('response.created', {
    type: 'response.created',
    response: { id: respId, status: 'in_progress', model, reasoning: respReasoning },
  });

  try {
    const resp = await callInteractionsApi(interactionBody, apiKey);

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '{}');
      yield sse('response.failed', {
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

    // 转换为 Responses API 响应
    const responseObj = interactionToResponses(data, inBody);

    // 模拟流式事件序列
    const msgItems = responseObj.output || [];

    // reasoning item
    const reasoningItem = msgItems.find(m => m.type === 'reasoning');
    if (reasoningItem) {
      const reasoningIndex = msgItems.indexOf(reasoningItem);
      yield sse('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: reasoningIndex,
        item: { type: 'reasoning', id: reasoningItem.id, summary: [] },
      });
      const summaryText = reasoningItem.summary?.[0]?.text || '';
      if (summaryText) {
        yield sse('response.reasoning_summary_part.added', {
          type: 'response.reasoning_summary_part.added',
          item_id: reasoningItem.id,
          output_index: reasoningIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        });
        yield sse('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta',
          item_id: reasoningItem.id,
          output_index: reasoningIndex,
          summary_index: 0,
          delta: summaryText,
        });
        yield sse('response.reasoning_summary_text.done', {
          type: 'response.reasoning_summary_text.done',
          item_id: reasoningItem.id,
          output_index: reasoningIndex,
          summary_index: 0,
          text: summaryText,
        });
        yield sse('response.reasoning_summary_part.done', {
          type: 'response.reasoning_summary_part.done',
          item_id: reasoningItem.id,
          output_index: reasoningIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: summaryText },
        });
      }
      yield sse('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: reasoningIndex,
        item: reasoningItem,
      });
    }

    // message items
    const msgItem = msgItems.find(m => m.type === 'message');
    if (msgItem) {
      const msgIndex = msgItems.indexOf(msgItem);
      yield sse('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: msgIndex,
        item: { type: 'message', id: msgItem.id, role: 'assistant', status: 'in_progress', content: [] },
      });
      const text = msgItem.content?.[0]?.text || '';
      if (text) {
        yield sse('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: msgItem.id,
          output_index: msgIndex,
          delta: text,
        });
      }
      yield sse('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: msgIndex,
        item: msgItem,
      });
    }

    // response.completed
    yield sse('response.completed', {
      type: 'response.completed',
      response: responseObj,
    });
  } catch (err) {
    yield sse('response.failed', {
      type: 'response.failed',
      response: {
        id: respId,
        status: 'failed',
        error: { code: 'interactions_error', message: err.message || 'Interactions API call failed' },
      },
    });
  }
}

// ── 主入口 ──
export async function handleResponsesApi(req, reqId) {
  try {
    const rawBody = await req.text();
    const inBody = JSON.parse(rawBody || '{}');
    const model = inBody.model || '';

    // 提取 API Key
    const authHeader = req.headers.get('authorization') || '';
    const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    // ── Agent 模型 → Interactions API ──
    if (isAgentModel(model)) {
      console.log(`[${reqId}] Agent model detected: ${model} → routing to Interactions API`);

      // 从 previous_response_id 解析出 previous_interaction_id
      let previousInteractionId = null;
      if (inBody.previous_response_id) {
        previousInteractionId = await getInteractionId(inBody.previous_response_id);
        if (previousInteractionId) {
          console.log(`[${reqId}] Mapped previous_response_id → interaction_id: ${previousInteractionId}`);
        }
      }

      // 构建 Interactions API body
      const interactionBody = responsesToInteraction(inBody);
      if (previousInteractionId) {
        interactionBody.previous_interaction_id = previousInteractionId;
      }

      const cors = getCors(req);

      if (inBody.stream) {
        // 流式 — 用非流式取结果后模拟 SSE
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            try {
              for await (const sse of streamFromInteractions(inBody, interactionBody, apiKey)) {
                controller.enqueue(encoder.encode(sse));
              }
            } catch (err) {
              console.error(`[${reqId}] Interactions stream error: ${err.message}`);
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Request-Id': reqId,
            ...cors,
          },
        });
      }

      // 非流式
      const resp = await callInteractionsApi(interactionBody, apiKey);

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '{}');
        return new Response(errBody, {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId, ...cors },
        });
      }

      const data = await resp.json();
      const responseObj = interactionToResponses(data, inBody);

      return new Response(JSON.stringify(responseObj), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId, ...cors },
      });
    }

    // ── 常规模型 → Chat Completions 兼容层（原有逻辑） ──
    // 从 previous_response_id 重建历史
    let historyMessages = [];
    if (inBody.previous_response_id) {
      historyMessages = await sessionGetHistory(inBody.previous_response_id);
    }

    // 转换为 Chat Completions 请求
    const chatBody = responsesToChat(inBody);

    // 合并历史
    if (historyMessages.length > 0) {
      const systemMsgs = chatBody.messages.filter(m => m.role === 'system');
      const nonSystemMsgs = chatBody.messages.filter(m => m.role !== 'system');
      // 历史中的 assistant 消息可能有 reasoning_content，转回 <thought> 标签
      for (const msg of historyMessages) {
        if (msg.role === 'assistant' && msg.reasoning_content) {
          msg.content = `<thought>${msg.reasoning_content}</thought>\n\n${msg.content || ''}`.trim();
          delete msg.reasoning_content;
        }
      }
      chatBody.messages = [...systemMsgs, ...historyMessages, ...nonSystemMsgs];

      // ⚠️ Google API 强制要求 tool 消息带 name 字段（函数名），否则 400/500
      for (let i = 0; i < chatBody.messages.length; i++) {
        const msg = chatBody.messages[i];
        if (msg.role === 'tool' && !msg.name) {
          for (let j = i - 1; j >= 0; j--) {
            const prev = chatBody.messages[j];
            if (prev.role === 'assistant' && prev.tool_calls) {
              const matched = prev.tool_calls.find(tc => tc.id === msg.tool_call_id);
              if (matched) { msg.name = matched.function?.name || ''; break; }
            }
          }
        }
      }
    }

    // 清理 Google 不支持的字段
    const sanitizedChatBody = sanitizeChatBody(chatBody);

    // fetchFn 供 streamResponses 内部使用
    const fetchFn = async (url, opts) => {
      const headers = { ...opts.headers };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      return fetch(url, { ...opts, headers });
    };

    // 流式
    if (inBody.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const sse of streamResponses(inBody, sanitizedChatBody, fetchFn)) {
              controller.enqueue(encoder.encode(sse));
            }
          } catch (err) {
            console.error(`[${reqId}] Responses stream error: ${err.message}`);
            const errEvent = `event: response.failed\ndata: ${JSON.stringify({
              type: 'response.failed',
              response: {
                id: 'resp_error',
                status: 'failed',
                error: { code: 'internal_error', message: err.message || 'Unknown error' },
              },
            })}\n\n`;
            controller.enqueue(encoder.encode(errEvent));
          } finally {
            controller.close();
          }
        },
      });

      const cors = getCors(req);
      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Request-Id': reqId,
          ...cors,
        },
      });
    }

    // 非流式
    const upstreamUrl = `${GOOGLE_API_BASE}/v1beta/openai/chat/completions`;
    const upstreamResp = await fetchFn(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sanitizedChatBody),
    });

    if (!upstreamResp.ok) {
      const errBody = await upstreamResp.text().catch(() => '{}');
      const cors = getCors(req);
      return new Response(errBody, {
        status: upstreamResp.status,
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId, ...cors },
      });
    }

    const data = await upstreamResp.json();
    const responseObj = await chatToResponses(data, inBody, sanitizedChatBody);

    const cors = getCors(req);
    return new Response(JSON.stringify(responseObj), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId, ...cors },
    });
  } catch (err) {
    console.error(`[${reqId}] Responses API error:`, err);
    const cors = getCors(req);
    return new Response(JSON.stringify({
      error: { message: err.message || 'Internal error', type: 'proxy_error', code: 500 },
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId, ...cors },
    });
  }
}
