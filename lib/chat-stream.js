// lib/chat-stream.js
// Chat Completions 流式转换的**唯一实现**（Vercel 与 Cloudflare Worker 共用）
//
// ⚠️ 背景：此前 Vercel 端（app/api/[[...path]]/route.js）与 CF 端
//    （cloudflare-worker/src/index.js）各写了一份「把上游 JSON/SSE 转成客户端 SSE」
//    的逻辑，结果是：
//      · Vercel 端没有跨事件 <thought> 状态机（思考内容被切碎后泄漏成正文）
//      · Vercel 端的非流式→SSE 拆分完全没有 tool_calls 分支（工具调用丢失）
//      · Vercel 端只识别 <thought>，不识别 <|thought>
//    本模块把能力统一到一处，两端 import 同一份实现，从根上消除行为分叉。
//
// 本模块是零依赖纯逻辑（只用 Web 标准 API），便于单元测试直接引入。

export const QCLAW_USER_AGENTS = ['qclaw', 'workbuddy'];

/**
 * 判断客户端是否属于「QClaw / WorkBuddy」系。
 *
 * ⚠️ 为什么要区分：这类客户端对 SSE 格式极其敏感，直接透传 Google 的原生流
 *    会解析失败（历史上报 400 / "empty stream"）。对它们采用「非流式取回 +
 *    手工拆分 SSE」的兼容模式；其他客户端走真流式直通。
 *
 * @param {string} userAgent
 * @returns {boolean}
 */
export function isQclawCompatClient(userAgent) {
  if (!userAgent || typeof userAgent !== 'string') return false;
  const ua = userAgent.toLowerCase();
  return QCLAW_USER_AGENTS.some(name => ua.includes(name));
}

/**
 * 创建跨 SSE 事件的 <thought> 剥离器（状态机）。
 *
 * 支持两种标签格式：
 *   <thought>...</thought>
 *   <|thought>...</|thought>
 *
 * 用法：
 *   const stripper = createThoughtStripper();
 *   const { reasoning, content } = stripper.strip(rawDeltaText);
 *   // 结束时调用 stripper.flush() 取回未闭合的残留思考内容
 */
export function createThoughtStripper() {
  let thoughtBuffer = '';
  let inThought = false;
  let thoughtTag = ''; // '<thought>' 或 '<|thought>'

  function strip(raw) {
    let reasoning = '';
    let content = '';

    if (inThought) {
      const closeTag = thoughtTag === '<|thought>' ? '<|/thought>' : '</thought>';
      const endIdx = raw.indexOf(closeTag);
      if (endIdx >= 0) {
        thoughtBuffer += raw.slice(0, endIdx);
        reasoning = thoughtBuffer;
        thoughtBuffer = '';
        inThought = false;
        thoughtTag = '';
        const after = raw.slice(endIdx + closeTag.length);
        if (after) content = after;
      } else {
        thoughtBuffer += raw;
      }
    } else {
      let startIdx = raw.indexOf('<thought>');
      let detectedTag = '<thought>';
      if (startIdx < 0) {
        startIdx = raw.indexOf('<|thought>');
        detectedTag = '<|thought>';
      }
      if (startIdx >= 0) {
        content = raw.slice(0, startIdx);
        const afterTag = raw.slice(startIdx + detectedTag.length);
        const closeTag = detectedTag === '<|thought>' ? '<|/thought>' : '</thought>';
        const endIdx = afterTag.indexOf(closeTag);
        if (endIdx >= 0) {
          // 同一个 delta 内闭合
          reasoning = afterTag.slice(0, endIdx);
          const after = afterTag.slice(endIdx + closeTag.length);
          if (after) content += after;
        } else {
          // 跨 delta → 进入缓冲模式
          inThought = true;
          thoughtTag = detectedTag;
          thoughtBuffer = afterTag;
        }
      } else {
        content = raw;
      }
    }

    return { reasoning, content };
  }

  /** 流结束时取回未闭合的残留思考内容（避免思考内容丢失或泄漏成正文） */
  function flush() {
    if (inThought && thoughtBuffer) {
      const rest = thoughtBuffer;
      thoughtBuffer = '';
      inThought = false;
      thoughtTag = '';
      return rest;
    }
    thoughtBuffer = '';
    inThought = false;
    thoughtTag = '';
    return '';
  }

  return { strip, flush, get inThought() { return inThought; } };
}

/**
 * 从「非流式的完整 Chat Completions JSON」构造客户端期望的 SSE chunk 序列。
 *
 * 顺序：reasoning_content → content → tool_calls → finish_reason → [DONE]
 * ⚠️ tool_calls 分支此前只有 CF 端有，Vercel 端缺失 → 工具调用在备份部署上直接丢失。
 *
 * @param {object} jsonResponse 上游返回的 Chat Completions JSON
 * @param {object} [options]
 * @param {number} [options.chunkSize=50] 每个 SSE chunk 的文本长度
 * @returns {string[]} SSE 字符串数组（不含 'data: [DONE]'）
 */
export function buildChatCompletionChunks(jsonResponse, options = {}) {
  const chunkSize = options.chunkSize || 50;
  const chunks = [];

  const choice = jsonResponse?.choices?.[0] || {};
  const message = choice.message || {};
  const created = jsonResponse.created || Math.floor(Date.now() / 1000);
  const model = jsonResponse.model || 'unknown';
  const id = jsonResponse.id || 'chatcmpl-' + Date.now();

  function makeChunk(delta, finishReason = null) {
    return 'data: ' + JSON.stringify({
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      created,
      id,
      model,
      object: 'chat.completion.chunk',
    }) + '\n\n';
  }

  // 1️⃣ reasoning_content
  let reasoning = message.reasoning_content || '';
  let content = message.content || '';

  // 上游把思考塞在 content 的 <thought> 标签里 → 剥离并迁移到 reasoning_content
  if (!reasoning && content) {
    const stripper = createThoughtStripper();
    // 完整文本一次性喂进去即可（stripper 本身也支持跨块）
    let accumulatedContent = '';
    let accumulatedReasoning = '';
    // 逐字符推进以正确处理「同一段文本里多个标签」
    let rest = content;
    while (rest.length > 0) {
      const r = stripper.strip(rest);
      accumulatedReasoning += r.reasoning;
      accumulatedContent += r.content;
      if (!stripper.inThought) break;
      rest = '';
    }
    const tail = stripper.flush();
    if (tail) accumulatedReasoning += tail;
    if (accumulatedReasoning) {
      reasoning = accumulatedReasoning;
      content = accumulatedContent;
    }
  }

  if (reasoning) {
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      chunks.push(makeChunk({ role: 'assistant', reasoning_content: reasoning.slice(i, i + chunkSize), content: '' }));
    }
  }

  // 2️⃣ content
  if (content) {
    for (let i = 0; i < content.length; i += chunkSize) {
      chunks.push(makeChunk({ content: content.slice(i, i + chunkSize) }));
    }
  } else if (!reasoning) {
    // 至少发一个空 role chunk，让客户端知道 assistant 轮次开始
    chunks.push(makeChunk({ role: 'assistant', content: '' }));
  }

  // 3️⃣ tool_calls
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    for (let idx = 0; idx < toolCalls.length; idx++) {
      const tc = toolCalls[idx];
      // 构建第一个 chunk，包含 tool_calls 的完整基础字段
      // ⚠️ 透传 thought_signature 等额外字段（Google thinking 模型需要）
      const firstToolCall = {
        index: idx,
        id: tc.id,
        type: 'function',
        function: { name: tc.function?.name || '', arguments: '' },
      };
      // 透传额外字段（如 thought_signature）
      if (tc.thought_signature !== undefined) {
        firstToolCall.thought_signature = tc.thought_signature;
      }
      chunks.push(makeChunk({
        role: 'assistant',
        content: null,
        tool_calls: [firstToolCall],
      }));
      const args = tc.function?.arguments || '';
      if (args) {
        for (let j = 0; j < args.length; j += chunkSize) {
          chunks.push(makeChunk({
            tool_calls: [{
              index: idx,
              function: { arguments: args.slice(j, j + chunkSize) },
            }],
          }));
        }
      }
    }
  }

  // 4️⃣ finish_reason
  chunks.push(makeChunk({ role: 'assistant' }, choice.finish_reason || 'stop'));

  return chunks;
}

/** 客户端 SSE 流的结束标记 */
export const SSE_DONE = 'data: [DONE]\n\n';

/**
 * 上游错误 → SSE 错误包装。
 * 客户端请求流式时若收到 JSON 错误体，解析器会直接崩（"no body"），
 * 必须包成 `data: {...}` 形式。
 */
export function buildSseError(status, message, reqId) {
  return `data: ${JSON.stringify({
    error: { message: `Upstream Error ${status}: ${message}`, type: 'upstream_error', code: status, reqId },
  })}\n\n`;
}

/**
 * 真流式直通：把上游 SSE 逐行转发给客户端，并把 <thought> 迁移到 reasoning_content。
 *
 * 作为 async generator 产出「待写出的 SSE 文本片段」，调用方负责写入 Response 流。
 * 结束时若上游没有给 finish_reason，会补一条合成的 finish_reason（避免 "empty stream"）。
 *
 * @param {ReadableStream} upstreamBody
 * @param {object} [options]
 * @param {string} [options.reqId]
 * @returns {AsyncGenerator<string>}
 */
export async function* transformUpstreamSSE(upstreamBody, options = {}) {
  const reqId = options.reqId || '';
  const stripper = createThoughtStripper();
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let leftover = '';
  let sawFinishReason = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      leftover += decoder.decode(value, { stream: true });
      const lines = leftover.split('\n');
      leftover = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ') && !line.startsWith('data: [DONE]')) {
          try {
            const parsed = JSON.parse(line.slice(6));
            if (Array.isArray(parsed.choices)) {
              for (const choice of parsed.choices) {
                if (choice.delta && typeof choice.delta.content === 'string') {
                  const { reasoning, content } = stripper.strip(choice.delta.content);
                  choice.delta.content = content;
                  if (reasoning) {
                    choice.delta.reasoning_content = (choice.delta.reasoning_content || '') + reasoning;
                  }
                }
                // ⚠️ finish_reason 在 choice 层，不在 delta 里
                if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
                  sawFinishReason = true;
                }
              }
            }
            const hasContent = parsed.choices?.some(c =>
              c.delta?.content !== undefined
              || c.delta?.reasoning_content !== undefined
              || c.delta?.tool_calls !== undefined
            );
            const hasFinish = parsed.choices?.some(c => c.finish_reason !== undefined);
            if (hasContent || hasFinish) {
              yield 'data: ' + JSON.stringify(parsed) + '\n';
            }
          } catch {
            yield line + '\n';
          }
        } else {
          yield line + '\n';
        }
      }
    }
    // 刷新残留的半行
    if (leftover) yield leftover + '\n';
  } finally {
    // 未闭合的 <thought> → flush 为 reasoning_content（否则思考内容会泄漏成正文）
    const tail = stripper.flush();
    if (tail) {
      yield 'data: ' + JSON.stringify({
        choices: [{ delta: { reasoning_content: tail }, index: 0 }],
      }) + '\n';
    }
    // 上游没给 finish_reason → 补一条，避免客户端 "empty stream"
    if (!sawFinishReason) {
      yield 'data: ' + JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
      }) + '\n';
    }
    reader.cancel().catch(() => {});
  }
}
