// cloudflare-worker/src/interactions.js
// CF Worker 端 Interactions API 适配层（薄封装）
//
// ⚠️ 转换逻辑的唯一实现在 lib/interactions-core.js：
//    Vercel 与 Cloudflare Worker 共用同一份，避免两边悄悄分叉。
//    本文件只负责 Redis 会话映射（resp2inter / inter2resp）的 CF 侧实现。

import {
  AGENT_MODELS,
  isAgentModel,
  responsesToInteraction,
  interactionToResponses as interactionToResponsesCore,
  callInteractionsApi,
} from '../../lib/interactions-core.js';

export { AGENT_MODELS, isAgentModel, responsesToInteraction, callInteractionsApi };

// ── Session 双向映射（Upstash Redis REST） ──
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
  } catch { return null; }
}

export async function saveInteractionMapping(env, responseId, interactionId) {
  const ttl = 86400;
  await redisCmd(env, 'SET', `resp2inter:${responseId}`, interactionId, 'EX', ttl);
  await redisCmd(env, 'SET', `inter2resp:${interactionId}`, responseId, 'EX', ttl);
}

export async function getInteractionId(env, responseId) {
  return redisCmd(env, 'GET', `resp2inter:${responseId}`);
}

export function newResponseId() {
  return 'resp_' + Math.random().toString(16).slice(2, 14) + Date.now().toString(16).slice(-10);
}

/**
 * 把 Interactions API 响应转换为 Responses API 响应。
 * 与 core 版本相比，额外负责建立 resp2inter 映射。
 */
export function interactionToResponses(env, interactionData, originalBody, responseId) {
  const result = interactionToResponsesCore(interactionData, originalBody, responseId);
  const interactionId = result._interactionId;
  // _interactionId 仅供调用方建立映射，不应出现在返回给客户端的 JSON 里
  delete result._interactionId;
  if (interactionId) {
    saveInteractionMapping(env, result.id, interactionId).catch(() => {});
  }
  return result;
}
