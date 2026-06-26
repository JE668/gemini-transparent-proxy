// cloudflare-worker/src/responses.js
// Responses API 转换层（CF Worker 版）
// 从 lib/responses.js 移植，适配 CF Workers 运行时

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
  await redisCmd(env, 'SET', `session:${responseId}`, JSON.stringify(messages));
  await redisCmd(env, 'EXPIRE', `session:${responseId}`, '86400');
}

async function sessionStoreReasoning(env, callId, reasoning) {
  if (!reasoning || !callId) return;
  await redisCmd(env, 'SET', `reasoning:call:${callId}`, reasoning);
  await redisCmd(env, 'EXPIRE', `reasoning:call:${callId}`, '86400');
}

function newResponseId() {
  return 'resp_' + Math.random().toString(16).slice(2, 14) + Date.now().toString(16).slice(-10);
}

function genId(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2, 18)}`;
}

// ── 工具函数 ─────────────────────────────────────────────

function convertUsage(chatUsage) {
  if (!chatUsage) return null;
  return {
    input_tokens: chatUsage.prompt_tokens || 0,
    output_tokens: chatUsage.completion_tokens || 0,
    total_tokens: chatUsage.total_tokens || 0,
  };
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    const kind = t.type || '';
    if (kind === 'function') {
      const srcFn = t.function || t;
      const fn = {};
      for (const k of ['name', 'description', 'parameters', 'strict']) {
        if (k in srcFn) fn[k] = srcFn[k];
      }
      out.push({ type: 'function', function: fn });
    } else if (kind === 'namespace') {
      for (const sub of (t.tools || [])) {
        if (sub.type === 'function') {
          const srcFn = sub.function || sub;
          const fn = {};
          for (const k of ['name', 'description', 'parameters', 'strict']) {
            if (k in srcFn) fn[k] = srcFn[k];
          }
          out.push({ type: 'function', function: fn });
        }
      }
    }
  }
  return out;
}

function valueToChatContent(content) {
  if (content == null) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const hasNonText = content.some(p => p && typeof p === 'object' && !['input_text', 'text', 'output_text'].includes(p.type || ''));
    if (!hasNonText) return content.filter(p => p && typeof p === 'object').map(p => p.text || '').join('');
    return content.map(part => {
      if (!part || typeof part !== 'object') return { type: 'text', text: String(part) };
      const kind = part.type || '';
      if (['input_text', 'text', 'output_text'].includes(kind)) return { type: 'text', text: part.text || '' };
      if (kind === 'input_image') return { type: 'image_url', image_url: { url: part.image_url || '' } };
      if (kind === 'image_url') return { type: 'image_url', image_url: typeof part.image_url === 'string' ? { url: part.image_url } : part.image_url };
      return part;
    });
  }
  return String(content);
}

function extractThoughtTags(text) {
  if (!text) return { reasoning: '', cleanText: '' };
  const regex = /<thought>([\s\S]*?)<\/thought>/g;
  let reasoning = '';
  const cleanText = text.replace(regex, (_, m) => { reasoning += m; return ''; }).trim();
  return { reasoning, cleanText };
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── Responses API → Chat Completions 请求转换 ────────────

export function responsesToChat(body) {
  const messages = [];
  const systemText = body.instructions || body.system;
  if (systemText) messages.unshift({ role: 'system', content: systemText });

  const inputItems = body.input || [];
  if (typeof inputItems === 'string') {
    messages.push({ role: 'user', content: inputItems });
    return buildChatBody(body.model || '', messages, body);
  }

  let i = 0;
  while (i < inputItems.length) {
    const item = inputItems[i];
    const itemType = item.type || '';

    if (itemType === 'function_call') {
      const grouped = [];
      while (i < inputItems.length && inputItems[i].type === 'function_call') {
        const cur = inputItems[i];
        grouped.push({ id: cur.call_id || '', type: 'function', function: { name: cur.name || '', arguments: cur.arguments || '{}' } });
        i++;
      }
      messages.push({ role: 'assistant', content: null, tool_calls: grouped });
    } else if (itemType === 'function_call_output') {
      messages.push({ role: 'tool', content: String(item.output || ''), tool_call_id: item.call_id || '' });
      i++;
    } else if (itemType === 'reasoning') {
      i++;
    } else {
      let role = item.role || 'user';
      if (role === 'developer') role = 'system';
      const content = valueToChatContent(item.content);
      const msg = { role, content };
      if (role === 'system') {
        if (messages.length && messages[0].role === 'system') messages[0] = msg;
        else messages.unshift(msg);
      } else {
        messages.push(msg);
      }
      i++;
    }
  }

  return buildChatBody(body.model || '', messages, body);
}

function buildChatBody(model, messages, body) {
  const chatBody = { model, messages };
  if (body.tools?.length) {
    const chatTools = convertTools(body.tools);
    if (chatTools.length) chatBody.tools = chatTools;
  }
  if (body.stream) {
    chatBody.stream = true;
    chatBody.stream_options = { include_usage: true };
  }
  const rawEffort = body.reasoning_effort || (typeof body.reasoning === 'object' ? body.reasoning?.effort : '');
  if (rawEffort) chatBody.reasoning_effort = rawEffort;
  for (const k of ['temperature', 'top_p']) if (k in body) chatBody[k] = body[k];
  if ('max_output_tokens' in body) chatBody.max_tokens = body.max_output_tokens;
  return chatBody;
}

// ── 非流式响应转换 ────────────────────────────────────────

export async function chatToResponses(env, data, inBody, chatBody) {
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const outputItems = [];

  let reasoning = msg.reasoning_content;
  let text = msg.content;
  if (!reasoning && text) {
    const extracted = extractThoughtTags(text);
    if (extracted.reasoning) { reasoning = extracted.reasoning; text = extracted.cleanText; }
  }

  if (reasoning) {
    outputItems.push({ type: 'reasoning', id: genId('rs'), summary: [{ type: 'summary_text', text: reasoning }] });
  }
  if (text) {
    outputItems.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  }
  for (const tc of (msg.tool_calls || [])) {
    const fn = tc.function || {};
    outputItems.push({ type: 'function_call', call_id: tc.id || '', name: fn.name || '', arguments: fn.arguments || '' });
  }

  const responseId = newResponseId();
  const assistantMsg = { role: 'assistant', content: text || null };
  if (reasoning) assistantMsg.reasoning_content = reasoning;
  if (msg.tool_calls) {
    assistantMsg.tool_calls = msg.tool_calls;
    for (const tc of msg.tool_calls) await sessionStoreReasoning(env, tc.id || '', reasoning);
  }

  const fullHistory = [...(chatBody.messages || []), assistantMsg];
  await sessionSave(env, responseId, fullHistory);

  const respReasoning = { effort: (typeof inBody.reasoning === 'object' ? inBody.reasoning?.effort : '') || 'medium', summary: 'detailed' };

  return {
    id: responseId,
    object: 'response',
    model: inBody.model || '',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    reasoning: respReasoning,
    output: outputItems,
    usage: convertUsage(data.usage),
  };
}

// ── 流式转换: Chat SSE → Responses API SSE ───────────────

export async function handleResponsesStream(env, inBody, chatBody, apiKey) {
  const respId = newResponseId();
  const model = inBody.model || '';
  const requestMessages = chatBody.messages || [];

  const msgItemId = genId('msg');
  const reasoningItemId = genId('rs');
  let accumulatedText = '';
  let accumulatedReasoning = '';
  let toolCalls = {};
  let emittedMessageItem = false;
  let emittedReasoningItem = false;
  let msgOutputIndex = 0;
  let reasoningOutputIndex = -1;
  let allChunks = [];

  const respReasoning = { effort: (typeof inBody.reasoning === 'object' ? inBody.reasoning?.effort : '') || 'medium', summary: 'detailed' };

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    try {
      // response.created
      await writer.write(encoder.encode(sseEvent('response.created', {
        type: 'response.created',
        response: { id: respId, status: 'in_progress', model, reasoning: respReasoning },
      })));

      // 发给 Google
      const upstreamUrl = `${GOOGLE_API_BASE}/v1beta/openai/chat/completions`;
      const upstreamResp = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(chatBody),
      });

      if (!upstreamResp.ok) {
        const errBody = await upstreamResp.text().catch(() => 'Unknown error');
        await writer.write(encoder.encode(sseEvent('response.failed', {
          type: 'response.failed',
          response: { id: respId, status: 'failed', error: { code: String(upstreamResp.status), message: errBody.slice(0, 500) } },
        })));
        await writer.close();
        return;
      }

      const reader = upstreamResp.body.getReader();
      const decoder = new TextDecoder();
      let leftover = '';

      // <thought> 跨 chunk 缓冲状态机
      let inThought = false;
      let contentBuffer = '';
      const OPEN_TAG = '<thought>';
      const CLOSE_TAG = '</thought>';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        leftover += decoder.decode(value, { stream: true });
        const lines = leftover.split('\n');
        leftover = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ') || line.startsWith('data: [DONE]')) continue;
          let chunk;
          try { chunk = JSON.parse(line.slice(6)); } catch { continue; }
          allChunks.push(chunk);

          for (const choice of (chunk.choices || [])) {
            const delta = choice.delta || {};

            // reasoning_content
            const rc = delta.reasoning_content || '';
            if (rc) {
              if (!emittedReasoningItem) {
                reasoningOutputIndex = 0;
                msgOutputIndex = 1;
                await writer.write(encoder.encode(sseEvent('response.output_item.added', {
                  type: 'response.output_item.added', output_index: 0,
                  item: { type: 'reasoning', id: reasoningItemId, summary: [] },
                })));
                await writer.write(encoder.encode(sseEvent('response.reasoning_summary_part.added', {
                  type: 'response.reasoning_summary_part.added', item_id: reasoningItemId,
                  output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' },
                })));
                emittedReasoningItem = true;
              }
              accumulatedReasoning += rc;
              await writer.write(encoder.encode(sseEvent('response.reasoning_summary_text.delta', {
                type: 'response.reasoning_summary_text.delta', item_id: reasoningItemId,
                output_index: 0, summary_index: 0, delta: rc,
              })));
            }

            // text content (可能包含 <thought> 标签)
            const rawContent = delta.content || '';
            if (rawContent) {
              contentBuffer += rawContent;
              let processedContent = '';
              let processedReasoning = '';

              while (contentBuffer.length > 0) {
                if (inThought) {
                  const closeIdx = contentBuffer.indexOf(CLOSE_TAG);
                  if (closeIdx !== -1) {
                    processedReasoning += contentBuffer.slice(0, closeIdx);
                    contentBuffer = contentBuffer.slice(closeIdx + CLOSE_TAG.length);
                    inThought = false;
                  } else {
                    const partialClose = contentBuffer.lastIndexOf('<');
                    if (partialClose !== -1 && CLOSE_TAG.startsWith(contentBuffer.slice(partialClose))) {
                      processedReasoning += contentBuffer.slice(0, partialClose);
                      contentBuffer = contentBuffer.slice(partialClose);
                      break;
                    } else {
                      processedReasoning += contentBuffer;
                      contentBuffer = '';
                    }
                  }
                } else {
                  const openIdx = contentBuffer.indexOf(OPEN_TAG);
                  if (openIdx !== -1) {
                    processedContent += contentBuffer.slice(0, openIdx);
                    contentBuffer = contentBuffer.slice(openIdx + OPEN_TAG.length);
                    inThought = true;
                  } else {
                    const partialOpen = contentBuffer.lastIndexOf('<');
                    if (partialOpen !== -1 && OPEN_TAG.startsWith(contentBuffer.slice(partialOpen))) {
                      processedContent += contentBuffer.slice(0, partialOpen);
                      contentBuffer = contentBuffer.slice(partialOpen);
                      break;
                    } else {
                      processedContent += contentBuffer;
                      contentBuffer = '';
                    }
                  }
                }
              }

              // 发射 reasoning
              if (processedReasoning) {
                if (!emittedReasoningItem) {
                  reasoningOutputIndex = 0;
                  msgOutputIndex = 1;
                  await writer.write(encoder.encode(sseEvent('response.output_item.added', {
                    type: 'response.output_item.added', output_index: 0,
                    item: { type: 'reasoning', id: reasoningItemId, summary: [] },
                  })));
                  await writer.write(encoder.encode(sseEvent('response.reasoning_summary_part.added', {
                    type: 'response.reasoning_summary_part.added', item_id: reasoningItemId,
                    output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' },
                  })));
                  emittedReasoningItem = true;
                }
                accumulatedReasoning += processedReasoning;
                await writer.write(encoder.encode(sseEvent('response.reasoning_summary_text.delta', {
                  type: 'response.reasoning_summary_text.delta', item_id: reasoningItemId,
                  output_index: 0, summary_index: 0, delta: processedReasoning,
                })));
              }

              // 发射 text content
              if (processedContent) {
                if (!emittedMessageItem) {
                  if (emittedReasoningItem) {
                    await writer.write(encoder.encode(sseEvent('response.reasoning_summary_text.done', {
                      type: 'response.reasoning_summary_text.done', item_id: reasoningItemId,
                      output_index: 0, summary_index: 0, text: accumulatedReasoning,
                    })));
                    await writer.write(encoder.encode(sseEvent('response.reasoning_summary_part.done', {
                      type: 'response.reasoning_summary_part.done', item_id: reasoningItemId,
                      output_index: 0, summary_index: 0, part: { type: 'summary_text', text: accumulatedReasoning },
                    })));
                    await writer.write(encoder.encode(sseEvent('response.output_item.done', {
                      type: 'response.output_item.done', output_index: 0,
                      item: { type: 'reasoning', id: reasoningItemId, summary: [{ type: 'summary_text', text: accumulatedReasoning }] },
                    })));
                  }
                  await writer.write(encoder.encode(sseEvent('response.output_item.added', {
                    type: 'response.output_item.added', output_index: msgOutputIndex,
                    item: { type: 'message', id: msgItemId, role: 'assistant', status: 'in_progress', content: [] },
                  })));
                  emittedMessageItem = true;
                }
                accumulatedText += processedContent;
                await writer.write(encoder.encode(sseEvent('response.output_text.delta', {
                  type: 'response.output_text.delta', item_id: msgItemId,
                  output_index: msgOutputIndex, delta: processedContent,
                })));
              }
            }

            // tool calls
            for (const tcItem of (delta.tool_calls || [])) {
              const idx = tcItem.index || 0;
              const entry = toolCalls[idx] || (toolCalls[idx] = { id: '', name: '', arguments: '' });
              if (tcItem.id) entry.id = tcItem.id;
              const fn = tcItem.function || {};
              if (fn.name) entry.name += fn.name;
              if (fn.arguments) entry.arguments += fn.arguments;
            }
          }
        }
      }

      // 提取 <thought> 标签
      if (!accumulatedReasoning && accumulatedText) {
        const extracted = extractThoughtTags(accumulatedText);
        if (extracted.reasoning) {
          accumulatedReasoning = extracted.reasoning;
          accumulatedText = extracted.cleanText;
        }
      }

      // 纯 reasoning 未发送
      if (accumulatedReasoning && !emittedReasoningItem && !emittedMessageItem) {
        reasoningOutputIndex = 0;
        msgOutputIndex = 1;
        await writer.write(encoder.encode(sseEvent('response.output_item.added', {
          type: 'response.output_item.added', output_index: 0,
          item: { type: 'reasoning', id: reasoningItemId, summary: [{ type: 'summary_text', text: accumulatedReasoning }] },
        })));
        await writer.write(encoder.encode(sseEvent('response.output_item.done', {
          type: 'response.output_item.done', output_index: 0,
          item: { type: 'reasoning', id: reasoningItemId, summary: [{ type: 'summary_text', text: accumulatedReasoning }] },
        })));
        emittedReasoningItem = true;
      }

      // Close message item
      if (emittedMessageItem) {
        await writer.write(encoder.encode(sseEvent('response.output_item.done', {
          type: 'response.output_item.done', output_index: msgOutputIndex,
          item: { type: 'message', id: msgItemId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: accumulatedText }] },
        })));
      }

      // Function call items
      const sortedToolCalls = Object.keys(toolCalls).sort((a, b) => Number(a) - Number(b)).map(k => toolCalls[k]);
      const baseIndex = emittedMessageItem ? (msgOutputIndex + 1) : (emittedReasoningItem ? 1 : 0);
      const fcItems = [];
      for (let relIdx = 0; relIdx < sortedToolCalls.length; relIdx++) {
        const tc = sortedToolCalls[relIdx];
        const fcItemId = genId('fc');
        const outputIndex = baseIndex + relIdx;

        await writer.write(encoder.encode(sseEvent('response.output_item.added', {
          type: 'response.output_item.added', output_index: outputIndex,
          item: { type: 'function_call', id: fcItemId, call_id: tc.id, name: tc.name, arguments: '', status: 'in_progress' },
        })));
        if (tc.arguments) {
          await writer.write(encoder.encode(sseEvent('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta', item_id: fcItemId, output_index: outputIndex, delta: tc.arguments,
          })));
        }
        await writer.write(encoder.encode(sseEvent('response.output_item.done', {
          type: 'response.output_item.done', output_index: outputIndex,
          item: { type: 'function_call', id: fcItemId, call_id: tc.id, name: tc.name, arguments: tc.arguments, status: 'completed' },
        })));
        fcItems.push({ type: 'function_call', id: fcItemId, call_id: tc.id, name: tc.name, arguments: tc.arguments, status: 'completed' });
      }

      // Save session
      if (accumulatedReasoning) {
        for (const tc of sortedToolCalls) {
          if (tc.id) await sessionStoreReasoning(env, tc.id, accumulatedReasoning);
        }
      }
      const assistantMsg = { role: 'assistant', content: accumulatedText || null };
      if (accumulatedReasoning) assistantMsg.reasoning_content = accumulatedReasoning;
      if (sortedToolCalls.length) {
        assistantMsg.tool_calls = sortedToolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }));
      }
      const fullHistory = [...requestMessages, assistantMsg];
      await sessionSave(env, respId, fullHistory);

      // Build output + completed
      const outputItems = [];
      if (accumulatedReasoning) outputItems.push({ type: 'reasoning', id: reasoningItemId, summary: [{ type: 'summary_text', text: accumulatedReasoning }] });
      if (emittedMessageItem) outputItems.push({ type: 'message', id: msgItemId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: accumulatedText }] });
      outputItems.push(...fcItems);
      const usage = allChunks.length ? convertUsage(allChunks[allChunks.length - 1].usage) : null;

      await writer.write(encoder.encode(sseEvent('response.completed', {
        type: 'response.completed',
        response: { id: respId, status: 'completed', model, reasoning: respReasoning, output: outputItems, usage },
      })));

    } catch (err) {
      try {
        await writer.write(encoder.encode(sseEvent('response.failed', {
          type: 'response.failed',
          response: { id: respId, status: 'failed', error: { code: 'stream_error', message: err.message || 'Unknown error' } },
        })));
      } catch {}
    } finally {
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeadersObj(),
    },
  });
}

// ── 非流式处理 ────────────────────────────────────────────

export async function handleResponsesNonStream(env, inBody, chatBody, apiKey) {
  const upstreamUrl = `${GOOGLE_API_BASE}/v1beta/openai/chat/completions`;
  const upstreamResp = await fetch(upstreamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(chatBody),
  });

  if (!upstreamResp.ok) {
    const errBody = await upstreamResp.text().catch(() => '{}');
    return new Response(errBody, {
      status: upstreamResp.status,
      headers: { 'Content-Type': 'application/json', ...corsHeadersObj() },
    });
  }

  const data = await upstreamResp.json();
  const responseObj = await chatToResponses(env, data, inBody, chatBody);

  return new Response(JSON.stringify(responseObj), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeadersObj() },
  });
}

// ── 主处理入口 ────────────────────────────────────────────

export async function handleResponses(request, env) {
  const inBody = await request.json();

  // 从 previous_response_id 重建历史
  let historyMessages = [];
  if (inBody.previous_response_id) {
    historyMessages = await sessionGetHistory(env, inBody.previous_response_id);
  }

  const chatBody = responsesToChat(inBody);

  // 合并历史
  if (historyMessages.length > 0) {
    const systemMsgs = chatBody.messages.filter(m => m.role === 'system');
    const nonSystemMsgs = chatBody.messages.filter(m => m.role !== 'system');
    for (const msg of historyMessages) {
      if (msg.role === 'assistant' && msg.reasoning_content) {
        msg.content = `<thought>${msg.reasoning_content}</thought>\n\n${msg.content || ''}`.trim();
        delete msg.reasoning_content;
      }
    }
    chatBody.messages = [...systemMsgs, ...historyMessages, ...nonSystemMsgs];
  }

  // 提取 API Key
  const authHeader = request.headers.get('authorization') || '';
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (inBody.stream) {
    return handleResponsesStream(env, inBody, chatBody, apiKey);
  }
  return handleResponsesNonStream(env, inBody, chatBody, apiKey);
}

function corsHeadersObj() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
  };
}
