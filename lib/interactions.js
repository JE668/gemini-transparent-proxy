// lib/interactions.js
// Vercel 端 Interactions API 适配层（薄封装）
//
// ⚠️ 转换逻辑的唯一实现在 lib/interactions-core.js：
//    Vercel 与 Cloudflare Worker 共用同一份，避免两边悄悄分叉。
//    本文件只负责 Redis 会话映射（resp2inter / inter2resp）的 Vercel 侧实现。

import { getRedis } from './redis.js';
import {
  AGENT_MODELS,
  isAgentModel,
  responsesToInteraction,
  interactionToResponses as interactionToResponsesCore,
  callInteractionsApi,
} from './interactions-core.js';

export { AGENT_MODELS, isAgentModel, responsesToInteraction, callInteractionsApi };

// ── Session ID 双向映射（Redis） ──
// Codex 用 previous_response_id → 映射到 Interactions API 的 previous_interaction_id
// 以便跨轮对话无缝衔接

async function getR() {
  return getRedis();
}

export async function saveInteractionMapping(responseId, interactionId) {
  const r = await getR();
  if (!r) return;
  const ttl = 86400;
  try {
    await r.set(`resp2inter:${responseId}`, interactionId);
    await r.expire(`resp2inter:${responseId}`, ttl);
    await r.set(`inter2resp:${interactionId}`, responseId);
    await r.expire(`inter2resp:${interactionId}`, ttl);
  } catch {}
}

export async function getInteractionId(responseId) {
  const r = await getR();
  if (!r) return null;
  try { return (await r.get(`resp2inter:${responseId}`)) || null; } catch { return null; }
}

/**
 * 把 Interactions API 响应转换为 Responses API 响应。
 * 与 core 版本相比，额外负责建立 resp2inter 映射（fire-and-forget）。
 */
export function interactionToResponses(interactionData, originalBody, responseId) {
  const result = interactionToResponsesCore(interactionData, originalBody, responseId);
  const interactionId = result._interactionId;
  // _interactionId 仅供调用方建立映射，不应出现在返回给客户端的 JSON 里
  delete result._interactionId;
  if (interactionId) {
    saveInteractionMapping(result.id, interactionId).catch(() => {});
  }
  return result;
}
