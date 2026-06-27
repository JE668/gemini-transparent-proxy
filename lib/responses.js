// lib/responses.js
// OpenAI Responses API ↔ Chat Completions API 双向转换
// 使 Codex 客户端可以通过 /v1/responses 端点接入 Gemini 模型
// 移植自 codex-proxy (Mint-green/codex-proxy) 的 Python 实现

import { getRedis } from './redis.js';

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';

// ── SessionStore (Redis-backed) ──────────────────────────
// Codex 用 previous_response_id 重建对话历史
// CF Worker / Vercel 都是无状态的，用 Upstash Redis 持久化

async function getSessionRedis() {
  return getRedis();
}

export async function sessionGetHistory(responseId) {
  const redis = await getSessionRedis();
  if (!redis) return [];
  try {
    const raw = await redis.get(`session:${responseId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function sessionSave(responseId, messages) {
  const redis = await getSessionRedis();
  if (!redis) return;
  try {
    await redis.set(`session:${responseId}`, JSON.stringify(messages));
    // 24h TTL，避免无限增长
    await redis.expire(`session:${responseId}`, 86400);
  } catch {}
}

export async function sessionStoreReasoning(callId, reasoning) {
  if (!reasoning || !callId) return;
  const redis = await getSessionRedis();
  if (!redis) return;
  try {
    await redis.set(`reasoning:call:${callId}`, reasoning);
    await redis.expire(`reasoning:call:${callId}`, 86400);
  } catch {}
}

export async function sessionGetReasoning(callId) {
  const redis = await getSessionRedis();
  if (!redis) return null;
  try {
    return await redis.get(`reasoning:call:${callId}`) || null;
  } catch {
    return null;
  }
}

export async function sessionStoreTurnReasoning(assistantMsg, reasoning) {
  if (!reasoning) return;
  const redis = await getSessionRedis();
  if (!redis) return;
  try {
    const content = assistantMsg?.content;
    if (typeof content === 'string' && content) {
      // 用 content 的简单 hash 作为 key（不依赖 crypto.subtle，兼容 CF Worker）
      const { crypto } = globalThis;
      if (crypto?.subtle) {
        const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(content));
        const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        await redis.set(`reasoning:hash:${hash}`, reasoning);
        await redis.expire(`reasoning:hash:${hash}`, 86400);
      }
    }
    // 也按 tool_call id 存储
    for (const tc of (assistantMsg?.tool_calls || [])) {
      const cid = tc?.id;
      if (cid) await sessionStoreReasoning(cid, reasoning);
    }
  } catch {}
}

export async function sessionGetTurnReasoning(assistantMsg) {
  const content = assistantMsg?.content;
  if (typeof content !== 'string' || !content) return null;
  const redis = await getSessionRedis();
  if (!redis) return null;
  try {
    const { crypto } = globalThis;
    if (crypto?.subtle) {
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(content));
      const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      return await redis.get(`reasoning:hash:${hash}`) || null;
    }
  } catch {}
  return null;
}

export function newResponseId() {
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
      // Google API 对 function 对象要求严格，只接受 name/description/parameters
      // (strict 是 OpenAI 特有字段，不要传给 Google 否则 500)
      const srcFn = t.function || t;
      const fn = {};
      for (const k of ['name', 'description', 'parameters']) {
        if (k in srcFn) fn[k] = srcFn[k];
      }
      out.push({ type: 'function', function: fn });
    } else if (kind === 'namespace') {
      // Codex 0.128+ MCP plugin grouping
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

// ── Responses API content → Chat content ─────────────────

function valueToChatContent(content) {
  if (content == null) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const hasNonText = content.some(p => p && typeof p === 'object' && !['input_text', 'text', 'output_text'].includes(p.type || ''));
    if (!hasNonText) {
      return content.filter(p => p && typeof p === 'object').map(p => p.text || '').join('');
    }
    // Multimodal
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

export function responsesToChat(body, modelMap = {}) {
  const messages = [];

  // 从 previous_response_id 重建历史
  // 注意：这里不 await，调用方需要先 await sessionGetHistory
  // 我们在 handler 里处理

  const modelName = body.model || '';
  const upstreamModel = modelMap[modelName] || modelName;

  // system / instructions
  const systemText = body.instructions || body.system;
  if (systemText) {
    if (!messages.length || messages[0].role !== 'system') {
      messages.unshift({ role: 'system', content: systemText });
    }
  }

  const inputItems = body.input || [];
  if (typeof inputItems === 'string') {
    messages.push({ role: 'user', content: inputItems });
    return buildChatBody(upstreamModel, messages, body);
  }

  // 处理 input items
  let i = 0;
  while (i < inputItems.length) {
    const item = inputItems[i];
    const itemType = item.type || '';

    if (itemType === 'function_call') {
      // Group consecutive function_calls
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
      // Skip — reasoning is recovered from session store
      i++;
    } else {
      // Regular message
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

  return buildChatBody(upstreamModel, messages, body);
}

function buildChatBody(model, messages, body) {
  const chatBody = { model, messages };

  if (body.tools && body.tools.length) {
    const chatTools = convertTools(body.tools);
    if (chatTools.length) chatBody.tools = chatTools;
  }

  if (body.stream) {
    chatBody.stream = true;
    // Google 的 OpenAI 兼容端点不支持 stream_options，会报 500
    // chatBody.stream_options = { include_usage: true };
  }

  // reasoning.effort
  let rawEffort = body.reasoning_effort;
  if (!rawEffort && typeof body.reasoning === 'object') {
    rawEffort = body.reasoning?.effort || '';
  }
  if (rawEffort) {
    chatBody.reasoning_effort = rawEffort;
  }

  for (const k of ['temperature', 'max_output_tokens', 'top_p']) {
    if (k in body) {
      if (k === 'max_output_tokens') {
        chatBody.max_tokens = body[k];
      } else {
        chatBody[k] = body[k];
      }
    }
  }

  return chatBody;
}

// ── 响应转换: Chat Completions → Responses API (非流式) ──

export async function chatToResponses(data, inBody, chatBody, modelMap = {}) {
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const outputItems = [];

  let reasoning = msg.reasoning_content;
  let text = msg.content;

  // 提取 <thought> 标签（Gemini 模型把思考放在 content 里）
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

  // 保存 session
  const responseId = newResponseId();
  const assistantMsg = { role: 'assistant', content: text || null };
  if (reasoning) assistantMsg.reasoning_content = reasoning;
  if (msg.tool_calls) {
    assistantMsg.tool_calls = msg.tool_calls;
    for (const tc of msg.tool_calls) {
      await sessionStoreReasoning(tc.id || '', reasoning);
    }
  }
  if (reasoning) await sessionStoreTurnReasoning(assistantMsg, reasoning);

  const fullHistory = [...(chatBody.messages || []), assistantMsg];
  await sessionSave(responseId, fullHistory);

  // 构建 reasoning echo
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

// ── SSE 事件辅助 ─────────────────────────────────────────

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function genId(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2, 18)}`;
}

// ── 流式转换: Chat SSE → Responses API SSE ───────────────

export async function* streamResponses(inBody, chatBody, fetchFn, modelMap = {}) {
  const respId = newResponseId();
  const model = inBody.model || '';
  const requestMessages = chatBody.messages || [];

  // 状态
  const msgItemId = genId('msg');
  const reasoningItemId = genId('rs');
  let accumulatedText = '';
  let accumulatedReasoning = '';
  let toolCalls = {}; // index → {id, name, arguments}
  let emittedMessageItem = false;
  let emittedReasoningItem = false;
  let msgOutputIndex = 0;
  let reasoningOutputIndex = -1;
  let streamDone = false;
  let allChunks = [];

  // reasoning echo
  const respReasoning = {};
  const reqReasoning = inBody.reasoning;
  if (typeof reqReasoning === 'object') {
    respReasoning.effort = reqReasoning?.effort || 'medium';
  }
  respReasoning.summary = 'detailed';

  // response.created
  yield sseEvent('response.created', {
    type: 'response.created',
    response: { id: respId, status: 'in_progress', model, reasoning: respReasoning },
  });

  try {
    // 发给上游（Google API），用传入的 fetchFn 抽象 Vercel/CF 差异
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

    // <thought> 跨 chunk 缓冲状态机
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
        try {
          chunk = JSON.parse(line.slice(6));
        } catch { continue; }
        allChunks.push(chunk);

        for (const choice of (chunk.choices || [])) {
          const delta = choice.delta || {};

          // reasoning_content (DeepSeek 风格 / 我们代理注入的)
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

          // text content (可能包含 <thought> 标签)
          const rawContent = delta.content || '';
          if (rawContent) {
            // <thought> 标签状态机：跨 chunk 缓冲
            contentBuffer += rawContent;
            let processedContent = '';
            let processedReasoning = '';

            while (contentBuffer.length > 0) {
              if (inThought) {
                // 在 thought 标签内，找闭合标签
                const closeIdx = contentBuffer.indexOf(CLOSE_TAG);
                if (closeIdx !== -1) {
                  // 找到闭合标签
                  processedReasoning += contentBuffer.slice(0, closeIdx);
                  contentBuffer = contentBuffer.slice(closeIdx + CLOSE_TAG.length);
                  inThought = false;
                } else {
                  // 还没闭合，检查是否可能是未完整的闭合标签
                  const partialClose = contentBuffer.lastIndexOf('<');
                  if (partialClose !== -1 && CLOSE_TAG.startsWith(contentBuffer.slice(partialClose))) {
                    // 可能是未完整的闭合标签，保留在 buffer
                    processedReasoning += contentBuffer.slice(0, partialClose);
                    contentBuffer = contentBuffer.slice(partialClose);
                    break;
                  } else {
                    // 全是 thought 内容
                    processedReasoning += contentBuffer;
                    contentBuffer = '';
                  }
                }
              } else {
                // 不在 thought 标签内，找开始标签
                const openIdx = contentBuffer.indexOf(OPEN_TAG);
                if (openIdx !== -1) {
                  // 找到开始标签
                  processedContent += contentBuffer.slice(0, openIdx);
                  contentBuffer = contentBuffer.slice(openIdx + OPEN_TAG.length);
                  inThought = true;
                } else {
                  // 检查是否可能是未完整的开始标签
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

            // 发射 reasoning_content
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

            // 发射 text content
            if (processedContent) {
              if (!emittedMessageItem) {
                // Close reasoning item first
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
                  item: {
                    type: 'message',
                    id: msgItemId,
                    role: 'assistant',
                    status: 'in_progress',
                    content: [],
                  },
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

          // tool call deltas
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

    // 提取 <thought> 标签（Gemini 把思考放在 content 中）
    if (!accumulatedReasoning && accumulatedText) {
      const extracted = extractThoughtTags(accumulatedText);
      if (extracted.reasoning) {
        accumulatedReasoning = extracted.reasoning;
        accumulatedText = extracted.cleanText;
      }
    }

    // 如果有 reasoning 但还没发过 reasoning item（纯 reasoning 或 tool-call 轮次）
    if (accumulatedReasoning && !emittedReasoningItem && !emittedMessageItem) {
      reasoningOutputIndex = 0;
      msgOutputIndex = 1;
      yield sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: reasoningItemId,
          summary: [{ type: 'summary_text', text: accumulatedReasoning }],
        },
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
      emittedReasoningItem = true;
    }

    // Close message item
    if (emittedMessageItem) {
      yield sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: msgOutputIndex,
        item: {
          type: 'message',
          id: msgItemId,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: accumulatedText }],
        },
      });
    }

    // Emit function_call items
    const sortedToolCalls = Object.keys(toolCalls).sort((a, b) => Number(a) - Number(b)).map(k => toolCalls[k]);
    const baseIndex = emittedMessageItem ? (msgOutputIndex + 1) : (emittedReasoningItem ? 1 : 0);
    const fcItems = [];
    for (let relIdx = 0; relIdx < sortedToolCalls.length; relIdx++) {
      const tc = sortedToolCalls[relIdx];
      const fcItemId = genId('fc');
      const outputIndex = baseIndex + relIdx;

      yield sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: {
          type: 'function_call',
          id: fcItemId,
          call_id: tc.id,
          name: tc.name,
          arguments: '',
          status: 'in_progress',
        },
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
        item: {
          type: 'function_call',
          id: fcItemId,
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          status: 'completed',
        },
      });

      fcItems.push({
        type: 'function_call',
        id: fcItemId,
        call_id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        status: 'completed',
      });
    }

    // 存 session
    if (accumulatedReasoning) {
      for (const tc of sortedToolCalls) {
        if (tc.id) await sessionStoreReasoning(tc.id, accumulatedReasoning);
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
    if (accumulatedReasoning) await sessionStoreTurnReasoning(assistantMsg, accumulatedReasoning);

    const fullHistory = [...requestMessages, assistantMsg];
    await sessionSave(respId, fullHistory);

    // Build output array
    const outputItems = [];
    if (accumulatedReasoning) {
      outputItems.push({
        type: 'reasoning',
        id: reasoningItemId,
        summary: [{ type: 'summary_text', text: accumulatedReasoning }],
      });
    }
    if (emittedMessageItem) {
      outputItems.push({
        type: 'message',
        id: msgItemId,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: accumulatedText }],
      });
    }
    outputItems.push(...fcItems);

    const usage = allChunks.length ? convertUsage(allChunks[allChunks.length - 1].usage) : null;

    yield sseEvent('response.completed', {
      type: 'response.completed',
      response: {
        id: respId,
        status: 'completed',
        model,
        reasoning: respReasoning,
        output: outputItems,
        usage,
      },
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