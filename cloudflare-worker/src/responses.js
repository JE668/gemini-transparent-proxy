// cloudflare-worker/src/responses.js
// Responses API 转换层（CF Worker 版）
// 增强：自动识别 agent 模型并路由到 Interactions API

import {
  isAgentModel,
  responsesToInteraction,
  interactionToResponses,
  callInteractionsApi,
  getInteractionId,
  saveInteractionMapping,
} from './interactions.js';

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

function newResponseId() {
  return 'resp_' + Math.random().toString(16).slice(2, 14) + Date.now().toString(16).slice(-10);
}

// ── Usage 转换 ───────────────────────────────────────────

function convertUsage(chatUsage) {
  if (!chatUsage) return null;
  const u = {
    input_tokens: chatUsage.prompt_tokens || 0,
    output_tokens: chatUsage.completion_tokens || 0,
    total_tokens: chatUsage.total_tokens || 0,
  };
  if (chatUsage.prompt_tokens_details) u.input_tokens_details = chatUsage.prompt_tokens_details;
  if (chatUsage.completion_tokens_details) u.output_tokens_details = chatUsage.completion_tokens_details;
  return u;
}

// ── Tools 转换 ───────────────────────────────────────────

function convertTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    const kind = t.type || '';
    if (kind === 'function') {
      const srcFn = t.function || t;
      const fn = {};
      for (const k of ['name', 'description', 'parameters']) {
        if (k in srcFn) fn[k] = srcFn[k];
      }
      out.push({ type: 'function', function: fn });
    } else if (kind === 'namespace') {
      for (const sub of (t.tools || [])) {
        if (sub.type === 'function') {
          const srcFn = sub.function || sub;
          const fn = {};
          for (const k of ['name', 'description', 'parameters']) {
            if (k in srcFn) fn[k] = srcFn[k];
          }
          out.push({ type: 'function', function: fn });
        }
      }
    }
  }
  return out;
}

// ── Content 转换 ─────────────────────────────────────────

function valueToChatContent(content) {
  if (content == null) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const hasNonText = content.some(p => p && typeof p === 'object' && !['input_text', 'text', 'output_text'].includes(p.type || ''));
    if (!hasNonText) {
      return content.filter(p => p && typeof p === 'object').map(p => p.text || '').join('');
    }
    return content.map(part => {
      if (!part || typeof part !== 'object') return { type: 'text', text: String(part) };
      const kind = part.type || '';
      if (['input_text', 'text', 'output_text'].includes(kind)) {
        return { type: 'text', text: part.text || '' };
      }
      if (kind === 'input_image') {
        return { type: 'image_url', image_url: { url: part.image_url || '' } };
      }
      if (kind === 'image_url') {
        const inner = typeof part.image_url === 'string' ? { url: part.image_url } : part.image_url;
        return { type: 'image_url', image_url: inner };
      }
      return part;
    });
  }
  return String(content);
}

// ── 请求转换: Responses API → Chat Completions ──────────

function responsesToChat(body) {
  const messages = [];
  const modelName = body.model || '';

  const systemText = body.instructions || body.system;
  if (systemText) {
    if (!messages.length || messages[0].role !== 'system') {
      messages.unshift({ role: 'system', content: systemText });
    }
  }

  const inputItems = body.input || [];
  if (typeof inputItems === 'string') {
    messages.push({ role: 'user', content: inputItems });
    return buildChatBody(modelName, messages, body);
  }

  let i = 0;
  while (i < inputItems.length) {
    const item = inputItems[i];
    const itemType = item.type || '';

    if (itemType === 'function_call') {
      const grouped = [];
      while (i < inputItems.length && inputItems[i].type === 'function_call') {
        const cur = inputItems[i];
        grouped.push({
          id: cur.call_id || '',
          type: 'function',
          function: { name: cur.name || '', arguments: cur.arguments || '{}' },
        });
        i++;
      }
      messages.push({ role: 'assistant', content: null, tool_calls: grouped });
    } else if (itemType === 'function_call_output') {
      messages.push({
        role: 'tool',
        content: String(item.output || ''),
        tool_call_id: item.call_id || '',
      });
      i++;
    } else if (itemType === 'reasoning') {
      i++;
    } else {
      let role = item.role || 'user';
      if (role === 'developer') role = 'system';
      const content = valueToChatContent(item.content);
      const msg = { role, content };
      if (role === 'system') {
        if (messages.length && messages[0].role === 'system') {
          messages[0] = msg;
        } else {
          messages.unshift(msg);
        }
      } else {
        messages.push(msg);
      }
      i++;
    }
  }

  return buildChatBody(modelName, messages, body);
}

function buildChatBody(model, messages, body) {
  const chatBody = { model, messages };

  if (body.tools && body.tools.length) {
    const chatTools = convertTools(body.tools);
    if (chatTools.length) chatBody.tools = chatTools;
  }

  if (body.stream) {
    chatBody.stream = true;
  }

  let rawEffort = body.reasoning_effort;
  if (!rawEffort && typeof body.reasoning === 'object') {
    rawEffort = body.reasoning?.effort || '';
  }
  if (rawEffort) chatBody.reasoning_effort = rawEffort;

  for (const k of ['temperature', 'max_output_tokens', 'top_p']) {
    if (k in body) {
      chatBody[k === 'max_output_tokens' ? 'max_tokens' : k] = body[k];
    }
  }

  return chatBody;
}

// ── <thought> 标签提取 ───────────────────────────────────

function extractThoughtTags(text) {
  if (!text) return { reasoning: '', cleanText: '' };
  const regex = /<thought>([\s\S]*?)<\/thought>/g;
  let reasoning = '';
  const cleanText = text.replace(regex, (_, m) => {
    reasoning += m;
    return '';
  }).trim();
  return { reasoning, cleanText };
}

// ── 响应转换: Chat Completions → Responses API (非流式) ──

async function chatToResponses(env, data, inBody, chatBody) {
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const outputItems = [];

  let reasoning = msg.reasoning_content;
  let text = msg.content;

  if (!reasoning && text) {
    const extracted = extractThoughtTags(text);
    if (extracted.reasoning) {
      reasoning = extracted.reasoning;
      text = extracted.cleanText;
    }
  }

  if (reasoning) {
    outputItems.push({
      type: 'reasoning',
      id: 'rs_' + Math.random().toString(16).slice(2, 18),
      summary: [{ type: 'summary_text', text: reasoning }],
    });
  }
  if (text) {
    outputItems.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    });
  }
  for (const tc of (msg.tool_calls || [])) {
    const fn = tc.function || {};
    outputItems.push({
      type: 'function_call',
      call_id: tc.id || '',
      name: fn.name || '',
      arguments: fn.arguments || '',
    });
  }

  const responseId = newResponseId();
  const assistantMsg = { role: 'assistant', content: text || null };
  if (reasoning) assistantMsg.reasoning_content = reasoning;
  if (msg.tool_calls) {
    assistantMsg.tool_calls = msg.tool_calls;
    for (const tc of msg.tool_calls) {
      await sessionStoreReasoning(env, tc.id || '', reasoning);
    }
  }
  if (reasoning) await sessionStoreTurnReasoning(env, assistantMsg, reasoning);

  const fullHistory = [...(chatBody.messages || []), assistantMsg];
  await sessionSave(env, responseId, fullHistory);

  const respReasoning = {};
  const reqReasoning = inBody.reasoning;
  if (typeof reqReasoning === 'object') {
    respReasoning.effort = reqReasoning?.effort || 'medium';
  }
  respReasoning.summary = 'detailed';

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

// ── SSE 事件辅助 ─────────────────────────────────────────

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function genId(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2, 18)}`;
}

// ── 流式转换: Chat SSE → Responses API SSE ──

async function* streamResponses(env, inBody, chatBody, fetchFn) {
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
    const upstreamUrl = `${GOOGLE_API_BASE}/v1beta/openai/chat/completions`;
    const upstreamResp = await fetchFn(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody),
    });

    if (!upstreamResp.ok) {
      const errBody = await upstreamResp.text().catch(() => 'Unknown error');
      yield sseEvent('response.failed', {
        type: 'response.failed',
        response: {
          id: respId,
          status: 'failed',
          error: { code: String(upstreamResp.status), message: errBody.slice(0, 500) },
        },
      });
      return;
    }

    const reader = upstreamResp.body.getReader();
    const decoder = new TextDecoder();
    let leftover = '';
    let inThought = false;
    let thoughtBuffer = '';
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
          const rc = delta.reasoning_content || '';
          if (rc) {
            if (!emittedReasoningItem) {
              reasoningOutputIndex = 0;
              msgOutputIndex = 1;
              yield sseEvent('response.output_item.added', {
                type: 'response.output_item.added',
                output_index: 0,
                item: { type: 'reasoning', id: reasoningItemId, summary: [] },
              });
              yield sseEvent('response.reasoning_summary_part.added', {
                type: 'response.reasoning_summary_part.added',
                item_id: reasoningItemId,
                output_index: 0,
                summary_index: 0,
                part: { type: 'summary_text', text: '' },
              });
              emittedReasoningItem = true;
            }
            accumulatedReasoning += rc;
            yield sseEvent('response.reasoning_summary_text.delta', {
              type: 'response.reasoning_summary_text.delta',
              item_id: reasoningItemId,
              output_index: 0,
              summary_index: 0,
              delta: rc,
            });
          }

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

            if (processedReasoning) {
              if (!emittedReasoningItem) {
                reasoningOutputIndex = 0;
                msgOutputIndex = 1;
                yield sseEvent('response.output_item.added', {
                  type: 'response.output_item.added',
                  output_index: 0,
                  item: { type: 'reasoning', id: reasoningItemId, summary: [] },
                });
                yield sseEvent('response.reasoning_summary_part.added', {
                  type: 'response.reasoning_summary_part.added',
                  item_id: reasoningItemId,
                  output_index: 0,
                  summary_index: 0,
                  part: { type: 'summary_text', text: '' },
                });
                emittedReasoningItem = true;
              }
              accumulatedReasoning += processedReasoning;
              yield sseEvent('response.reasoning_summary_text.delta', {
                type: 'response.reasoning_summary_text.delta',
                item_id: reasoningItemId,
                output_index: 0,
                summary_index: 0,
                delta: processedReasoning,
              });
            }

            if (processedContent) {
              if (!emittedMessageItem) {
                if (emittedReasoningItem) {
                  yield sseEvent('response.reasoning_summary_text.done', {
                    type: 'response.reasoning_summary_text.done',
                    item_id: reasoningItemId,
                    output_index: 0,
                    summary_index: 0,
                    text: accumulatedReasoning,
                  });
                  yield sseEvent('response.reasoning_summary_part.done', {
                    type: 'response.reasoning_summary_part.done',
                    item_id: reasoningItemId,
                    output_index: 0,
                    summary_index: 0,
                    part: { type: 'summary_text', text: accumulatedReasoning },
                  });
                  yield sseEvent('response.output_item.done', {
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: {
                      type: 'reasoning',
                      id: reasoningItemId,
                      summary: [{ type: 'summary_text', text: accumulatedReasoning }],
                    },
                  });
                }
                yield sseEvent('response.output_item.added', {
                  type: 'response.output_item.added',
                  output_index: msgOutputIndex,
                  item: { type: 'message', id: msgItemId, role: 'assistant', status: 'in_progress', content: [] },
                });
                emittedMessageItem = true;
              }
              accumulatedText += processedContent;
              yield sseEvent('response.output_text.delta', {
                type: 'response.output_text.delta',
                item_id: msgItemId,
                output_index: msgOutputIndex,
                delta: processedContent,
              });
            }
          }

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

    if (!accumulatedReasoning && accumulatedText) {
      const extracted = extractThoughtTags(accumulatedText);
      if (extracted.reasoning) {
        accumulatedReasoning = extracted.reasoning;
        accumulatedText = extracted.cleanText;
      }
    }

    if (accumulatedReasoning && !emittedReasoningItem && !emittedMessageItem) {
      reasoningOutputIndex = 0;
      msgOutputIndex = 1;
      yield sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: reasoningItemId, summary: [{ type: 'summary_text', text: accumulatedReasoning }] },
      });
      yield sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: reasoningItemId, summary: [{ type: 'summary_text', text: accumulatedReasoning }] },
      });
      emittedReasoningItem = true;
    }

    if (emittedMessageItem) {
      yield sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: msgOutputIndex,
        item: { type: 'message', id: msgItemId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: accumulatedText }] },
      });
    }

    const sortedToolCalls = Object.keys(toolCalls).sort((a, b) => Number(a) - Number(b)).map(k => toolCalls[k]);
    const baseIndex = emittedMessageItem ? (msgOutputIndex + 1) : (emittedReasoningItem ? 1 : 0);
    for (let relIdx = 0; relIdx < sortedToolCalls.length; relIdx++) {
      const tc = sortedToolCalls[relIdx];
      const fcItemId = genId('fc');
      const outputIndex = baseIndex + relIdx;
      yield sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: { type: 'function_call', id: fcItemId, call_id: tc.id, name: tc.name, arguments: '', status: 'in_progress' },
      });
      if (tc.arguments) {
        yield sseEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: fcItemId,
          output_index: outputIndex,
          delta: tc.arguments,
        });
      }
      yield sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: { type: 'function_call', id: fcItemId, call_id: tc.id, name: tc.name, arguments: tc.arguments, status: 'completed' },
      });
    }

    if (accumulatedReasoning) {
      for (const tc of sortedToolCalls) {
        if (tc.id) await sessionStoreReasoning(env, tc.id, accumulatedReasoning);
      }
    }

    const assistantMsg = {
      role: 'assistant',
      content: accumulatedText || null,
    };
    if (accumulatedReasoning) assistantMsg.reasoning_content = accumulatedReasoning;
    if (sortedToolCalls.length) {
      assistantMsg.tool_calls = sortedToolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    if (accumulatedReasoning) await sessionStoreTurnReasoning(env, assistantMsg, accumulatedReasoning);

    const fullHistory = [...requestMessages, assistantMsg];
    await sessionSave(env, respId, fullHistory);

    const outputItems = [];
    if (accumulatedReasoning) outputItems.push({ type: 'reasoning', id: reasoningItemId, summary: [{ type: 'summary_text', text: accumulatedReasoning }] });
    if (emittedMessageItem) outputItems.push({ type: 'message', id: msgItemId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: accumulatedText }] });
    outputItems.push(...sortedToolCalls.map(tc => ({
      type: 'function_call',
      id: genId('fc'),
      call_id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      status: 'completed',
    })));

    const usage = allChunks.length ? convertUsage(allChunks[allChunks.length - 1].usage) : null;

    yield sseEvent('response.completed', {
      type: 'response.completed',
      response: { id: respId, status: 'completed', model, reasoning: respReasoning, output: outputItems, usage },
    });
  } catch (err) {
    yield sseEvent('response.failed', {
      type: 'response.failed',
      response: {
        id: respId,
        status: 'failed',
        error: { code: 'stream_error', message: err.message || 'Unknown error' },
      },
    });
  }
}

// ── 非流式处理 ───────────────────────────────────────────

async function handleResponsesNonStream(env, inBody, chatBody, apiKey) {
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
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const data = await upstreamResp.json();
  const responseObj = await chatToResponses(env, data, inBody, chatBody);

  return new Response(JSON.stringify(responseObj), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeadersObj() },
  });
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
    // Save mapping
    if (data.id) {
      await saveInteractionMapping(env, respId, data.id);
    }

    const responseObj = interactionToResponses(data, inBody);
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
    const responseObj = interactionToResponses(data, inBody);

    // Save mapping
    if (data.id) {
      await saveInteractionMapping(env, responseObj.id, data.id);
    }

    return new Response(JSON.stringify(responseObj), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── 常规模型 → Chat Completions（原有逻辑） ──
  let historyMessages = [];
  if (inBody.previous_response_id) {
    historyMessages = await sessionGetHistory(env, inBody.previous_response_id);
  }

  const chatBody = responsesToChat(inBody);

  if (historyMessages.length > 0) {
    const systemMsgs = chatBody.messages.filter(m => m.role === 'system');
    const nonSystemMsgs = chatBody.messages.filter(m => m.role !== 'system');
    for (const msg of historyMessages) {
      if (msg.role === 'assistant' && msg.reasoning_content) {
        delete msg.reasoning_content;
      }
    }
    chatBody.messages = [...systemMsgs, ...historyMessages, ...nonSystemMsgs];
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
        for await (const sse of streamResponses(env, inBody, chatBody, fetchFn)) {
          await writer.write(encoder.encode(sse));
        }
      } catch (err) {
        console.error(`Responses stream error: ${err.message}`);
        const errEvent = `event: response.failed\ndata: ${JSON.stringify({
          type: 'response.failed',
          response: {
            id: 'resp_error',
            status: 'failed',
            error: { code: 'internal_error', message: err.message || 'Unknown error' },
          },
        })}\n\n`;
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
