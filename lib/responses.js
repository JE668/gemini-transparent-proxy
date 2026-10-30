// lib/responses.js
// Vercel 端 Responses API 适配层（薄封装）
//
// ⚠️ 转换逻辑的唯一实现在 lib/responses-core.js：
//    Vercel 与 Cloudflare Worker 共用同一份，避免两边悄悄分叉。
//    本文件只负责「Redis 会话存储适配」——把 core 需要的 session 接口
//    用 Vercel 侧的 Upstash Redis 实现出来。

import { getRedis } from './redis.js';
import { fetchWithModelFallback } from './upstream-retry.js';

import {
  newResponseId,
  responsesToChat,
  chatToResponses as chatToResponsesCore,
  streamResponses as streamResponsesCore,
  mergeHistoryMessages,
  sanitizeChatBody,
  convertUsage,
  convertTools,
  valueToChatContent,
  extractThoughtTags,
  sseEvent,
} from './responses-core.js';

export {
  newResponseId,
  responsesToChat,
  mergeHistoryMessages,
  sanitizeChatBody,
  convertUsage,
  convertTools,
  valueToChatContent,
  extractThoughtTags,
  sseEvent,
};

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

// ── core 需要的 session 适配器 ───────────────────────────

export const vercelSession = {
  getHistory: sessionGetHistory,
  save: sessionSave,
  storeReasoning: sessionStoreReasoning,
  getReasoning: sessionGetReasoning,
  storeTurnReasoning: sessionStoreTurnReasoning,
};

// ── 对外包装（保持既有调用签名） ─────────────────────────

export async function chatToResponses(data, inBody, chatBody) {
  return chatToResponsesCore(data, inBody, chatBody, vercelSession);
}

export async function* streamResponses(inBody, chatBody, fetchFn) {
  yield* streamResponsesCore(inBody, chatBody, fetchFn, vercelSession);
}

export { fetchWithModelFallback };
