// lib/responses-core.js
// Responses API ↔ Chat Completions 转换层的**唯一实现**（Vercel 与 Cloudflare Worker 共用）
//
// ⚠️ 背景：此前 lib/responses.js（836 行）与 cloudflare-worker/src/responses.js（990 行）
//    各维护一份几乎相同的转换逻辑，只有 Redis 访问方式不同（process.env vs env）。
//    后果是两边反复出现行为分叉（例如 CF 版会删掉历史里的 reasoning_content，
//    Vercel 版会把它转回 <thought> 标签），且 tests/sync.test.mjs 无法守卫。
//    现在把纯转换逻辑收敛到本模块，Redis 差异通过注入 session 适配器解决。
//
// 本模块不直接依赖 Redis，只依赖一个 session 接口：
//   {
//     getHistory(responseId): Promise<messages[]>
//     save(responseId, messages): Promise<void>
//     storeReasoning(callId, reasoning): Promise<void>
//     getReasoning(callId): Promise<string|null>
//     storeTurnReasoning(assistantMsg, reasoning): Promise<void>
//   }

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';

// ⚠️ Google OpenAI 兼容端点不接受的一批字段（由 lib/openai-compat.js 统一维护）
import { GOOGLE_OPENAI_BLOCKED } from './openai-compat.js';
import { fetchWithModelFallback } from './upstream-retry.js';

/**
 * 清理 Google 不支持的字段。
 * ⚠️ 此前只有 Vercel 端做这步，CF 端直接把 Responses 请求体转发给 Google，
 *    导致带 `strict` / `null` 字段的请求在两端行为不一致（CF 端 500）。
 *    现在收敛到 core，两端共用。
 */
export function sanitizeChatBody(body) {
  const cleaned = { ...body };
  for (const key of Object.keys(cleaned)) {
    if (GOOGLE_OPENAI_BLOCKED.has(key) || cleaned[key] === null) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

// ── ID 生成 ──────────────────────────────────────────────

export function newResponseId() {
  return 'resp_' + Math.random().toString(16).slice(2, 14) + Date.now().toString(16).slice(-10);
}

function genId(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2, 18)}`;
}

// ── Usage 转换 ───────────────────────────────────────────

export function convertUsage(chatUsage) {
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

export function convertTools(tools) {
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

export function valueToChatContent(content) {
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

export function buildChatBody(model, messages, body) {
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

// ── <thought> 标签提取 ───────────────────────────────────

export function extractThoughtTags(text) {
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

export function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── 响应转换: Chat Completions → Responses API (非流式) ──

export async function chatToResponses(data, inBody, chatBody, session) {
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
      await session.storeReasoning(tc.id || '', reasoning);
    }
  }
  if (reasoning) await session.storeTurnReasoning(assistantMsg, reasoning);

  const fullHistory = [...(chatBody.messages || []), assistantMsg];
  await session.save(responseId, fullHistory);

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

// ── 流式转换: Chat SSE → Responses API SSE ───────────────

export async function* streamResponses(inBody, chatBody, fetchFn, session) {
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
  const allChunks = [];

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
    // ⚠️ 上游 429/5xx 时按「同模型退避重试 → 模型降级」兜底（与聊天路径同一套策略）。
    //    降级发生在拿到上游响应头、尚未推送任何内容增量之前，因此流不会被撕裂；
    //    已发出的 response.created 信封仍报告客户端请求的模型名（客户端行为不变）。
    const { response: upstreamResp } = await fetchWithModelFallback({
      fetchFn,
      url: upstreamUrl,
      headers: { 'Content-Type': 'application/json' },
      body: chatBody,
      modelId: chatBody.model,
      onFallback: (from, to, status) => {
        console.log(`[Responses] Model fallback: ${from} → ${to} (${status})`);
      },
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
            let contentBuffer = rawContent;
            let processedContent = '';
            let processedReasoning = '';

            while (contentBuffer.length > 0) {
              if (inThought) {
                // 在 thought 标签内，找闭合标签
                const closeIdx = contentBuffer.indexOf(CLOSE_TAG);
                if (closeIdx !== -1) {
                  processedReasoning += contentBuffer.slice(0, closeIdx);
                  contentBuffer = contentBuffer.slice(closeIdx + CLOSE_TAG.length);
                  inThought = false;
                } else {
                  // 还没闭合，检查是否可能是未完整的闭合标签
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
                // 不在 thought 标签内，找开始标签
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
        if (tc.id) await session.storeReasoning(tc.id, accumulatedReasoning);
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
    if (accumulatedReasoning) await session.storeTurnReasoning(assistantMsg, accumulatedReasoning);

    const fullHistory = [...requestMessages, assistantMsg];
    await session.save(respId, fullHistory);

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

/**
 * 合并 previous_response_id 恢复出的历史消息。
 *
 * ⚠️ 两端此前行为不一致：Vercel 端把历史里的 reasoning_content 转回 <thought> 标签，
 *    CF 端直接把 reasoning_content 删掉。前者能保留思考上下文，后者会丢失。
 *    现在统一采用「转回 <thought> 标签」——Google 会重新解析它，语义更完整。
 *
 * @param {object} chatBody 已转换好的 Chat 请求体（会被就地修改）
 * @param {Array} historyMessages 恢复出的历史
 * @returns {object} 修改后的 chatBody
 */
export function mergeHistoryMessages(chatBody, historyMessages) {
  if (!Array.isArray(historyMessages) || historyMessages.length === 0) return chatBody;

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

  return chatBody;
}
