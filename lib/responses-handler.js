// lib/responses-handler.js
// Vercel 端 Responses API 处理入口
// 被 app/api/[[...path]]/route.js 调用，处理 /v1/responses 请求

import {
  responsesToChat,
  chatToResponses,
  streamResponses,
  sessionGetHistory,
  sessionStoreReasoning,
} from './responses.js';

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

export async function handleResponsesApi(req, reqId) {
  try {
    const rawBody = await req.text();
    const inBody = JSON.parse(rawBody || '{}');

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

    // 提取 API Key
    const authHeader = req.headers.get('authorization') || '';
    const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

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
