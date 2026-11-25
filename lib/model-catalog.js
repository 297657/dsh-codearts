/**
 * WorkBuddy 模型目录的端点兼容层（wbipc 与直连两个客户端共用）。
 *
 * `/v2/enterprises/personal/models` 已被服务端下线（404 Route Not Found），
 * 模型列表导致适配器回退到内置 6 个旧模型，`hy4flash` 等新模型全部消失。
 * 当前客户端实际读 `/v3/config`，其 `data.models` 字段与旧接口兼容，且包含
 * 全部 27 个条目。这里按新 → 旧顺序尝试，都拿不到就返回空数组，由上层
 * `runtime.models()` 回退内置清单（不抛错，避免把整个渠道打掉）。
 *
 * 新接口还混入了图片/视频生成模型（如 hy-image-3.5、kling-video-v3），
 * 它们只有 id/name/tags，没有 token 预算字段，不是聊天模型。必须滤掉，
 * 否则模型选择器里会出现点了不能用的条目。
 */

const ENDPOINTS = ['/v3/config', '/v2/enterprises/personal/models']

function chatModels(json) {
  const rows = json?.data?.models
  if (!Array.isArray(rows)) return []
  return rows.filter(row => row !== null && typeof row === 'object'
    && typeof row.id === 'string' && row.id !== ''
    && (Number(row.maxInputTokens) > 0 || row.supportsToolCall === true))
}

/**
 * @param {(method: string, path: string, options?: object) => Promise<{json?: object}>} httpFetch
 * @returns {Promise<object[]>} 原始聊天模型条目；端点都不可用时返回 []
 */
export async function fetchModelRows(httpFetch) {
  for (const path of ENDPOINTS) {
    try {
      const result = await httpFetch('GET', path, { headers: { 'content-type': 'application/json' } })
      const rows = chatModels(result?.json)
      if (rows.length > 0) return rows
    } catch {
      // 这个端点不可用（旧版服务端 / 网络抖动），换下一个
    }
  }
  return []
}

/** 远端条目 → 适配器内部模型元数据。 */
export function mapModelRow(row) {
  return {
    id: row.id.trim(),
    name: String(row.name || row.id).trim(),
    contextWindow: Number(row.maxInputTokens) > 0 ? Number(row.maxInputTokens) : 131_072,
    maxOutput: Number(row.maxOutputTokens) > 0 ? Number(row.maxOutputTokens) : 32_768,
    vision: row.supportsImages === true,
    supportsReasoning: row.supportsReasoning === true,
    supportsToolCall: row.supportsToolCall !== false,
    ...(row.supportsReasoning === true
      ? {
          reasoning: {
            effort: row.reasoning?.effort ?? 'high',
            supportedEfforts: Array.isArray(row.reasoning?.supportedEfforts) ? row.reasoning.supportedEfforts : [],
            canDisableThinking: row.reasoning?.canDisableThinking === true,
            defaultEffort: row.reasoning?.defaultEffort ?? row.reasoning?.effort ?? 'high',
          },
        }
      : {}),
  }
}
