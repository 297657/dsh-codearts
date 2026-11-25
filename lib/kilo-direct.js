/**
 * Kilo Gateway 免费池的**直连**聊天通道。
 *
 * 为什么直连：原先 DSH 的 magpie 模型走 Magpie 桌面应用的本地网关
 * （127.0.0.1:3425），再由它转发到 Kilo。那一跳会挂死（实测 115 秒后 EOF），
 * 而且它默认选的 `kilo-auto/free` 会把请求转给 Baidu 共享池，触发
 * `tpm_rate_limit_exceeded`。这里去掉中间人，直接请求 Kilo 上游：
 *
 *   - 免费模型匿名可用，不需要任何账号凭据（Kilo 只给付费模型要登录）；
 *   - 同一出口的限流只针对**具体模型**，换模型即可绕开，不像网关那样整体卡死；
 *   - 标准 OpenAI SSE，DSH 的事件格式与 CodeArts 渠道一致，可直接复用。
 *
 * 模型清单不动态拉：上游 `/models` 有 467 条，其中免费 21 条，但混着
 * 付费需登录（kilo-auto/efficient|frontier|balanced）、共享池限流
 * （kilo-auto/free、baidu/ernie、liquid/lfm）与超时（super-vl）的条目。
 * 列出来点了必失败，所以只保留**实测匿名直连 200**的白名单。
 */

import { randomBytes } from 'node:crypto'

import { FALLBACK_IMAGE_PRICING } from './image-pricing.js'
import { serializeMessages } from './codearts-llm.js'

const BASE = 'https://api.kilo.ai/api/openrouter'
const MODELS_URL = `${BASE}/models`
const CHAT_URL = `${BASE}/chat/completions`
const FETCH_TIMEOUT_MS = 30_000

/**
 * 开思考时的最低输出预算。免费 thinking 模型先把 token 花在 reasoning 上，
 * 预算太小正文就空了；实测 nemotron lightning 用 512 token + medium 仍无正文，
 * low 档 512 能出。给 1024 留出思考+正文两段空间。
 */
const THINKING_TOKEN_FLOOR = 1024

/**
 * 实测匿名可用的免费模型（2026-11-25）：
 *   kilo-auto/small                                    1607ms
 *   openrouter/free                                    2156ms（自动路由）
 *   nvidia/nemotron-3.5-lightning:free                 1449ms
 *   nvidia/nemotron-3-ultra-550b-a55b:free             1958ms
 *   nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free  804ms（视觉）
 *   inclusionai/ling-3.2-flash:free                    2792ms（视觉）
 *   particle-ai/particle-1:free                        1916ms（视觉）
 *   recursive/flint-v1.0:free                          2010ms
 *
 * 明确不收录：kilo-auto/free（Baidu 共享池 429）、baidu/ernie-*-preview
 * （同共享池）、liquid/lfm-3-1.7b:free（429）、nvidia/nemotron-3.5-super-vl
 * （12 秒超时）、kilo-auto/{efficient,frontier,balanced}（401 需登录）、
 * cohere/north-mini-code:free（404 已下架）。
 */
export const FREE_MODELS = Object.freeze([
  { id: 'openrouter/free', name: 'Kilo · 免费自动路由', vision: true, contextWindow: 200_000 },
  { id: 'kilo-auto/small', name: 'Kilo · 自动小模型', vision: true, contextWindow: 262_144 },
  { id: 'nvidia/nemotron-3.5-lightning:free', name: 'NVIDIA Nemotron 3.5 Lightning（免费）', vision: false, contextWindow: 1_000_000 },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'NVIDIA Nemotron 3 Ultra（免费）', vision: false, contextWindow: 1_000_000 },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', name: 'NVIDIA Nemotron 3 Nano Omni（免费·视觉）', vision: true, contextWindow: 256_000 },
  { id: 'inclusionai/ling-3.2-flash:free', name: 'inclusionAI Ling 3.2 Flash（免费·视觉）', vision: true, contextWindow: 1_048_576 },
  { id: 'particle-ai/particle-1:free', name: 'Particle AI Particle-1（免费·视觉）', vision: true, contextWindow: 1_048_576 },
  { id: 'recursive/flint-v1.0:free', name: 'Recursive Flint（免费）', vision: false, contextWindow: 262_144 },
])

const MODEL_MAP = new Map(FREE_MODELS.map(row => [row.id, row]))
const DEFAULT_MAX_OUTPUT = 32_768

function modelRow(id) {
  return MODEL_MAP.get(id)
    ?? { id, name: id, vision: false, contextWindow: 131_072 }
}

/** 汇总上游错误，给出用户能执行的提示（而不是把原始 JSON 甩出来）。 */
function wallError(status, payload) {
  const code = payload?.error?.code ?? payload?.code
  const message = payload?.error?.message ?? payload?.message
  if (status === 401 || code === 'PAID_MODEL_AUTH_REQUIRED') {
    return Object.assign(new Error('该模型需要登录 Kilo 账号，不在免费池内；请换一个 Kilo 免费模型'), { code: 'NO_ENTITLEMENT' })
  }
  if (status === 429 || /rate.?limit/i.test(String(message))) {
    return Object.assign(new Error(`Kilo 免费池限流：${message ?? '请稍后重试或换一个模型'}`), { code: 'RATE_LIMITED' })
  }
  if (status === 404) {
    return Object.assign(new Error('模型已下架，请换一个 Kilo 免费模型'), { code: 'MODEL_NOT_FOUND' })
  }
  return Object.assign(new Error(`Kilo 直连失败（${status}）：${message ?? JSON.stringify(payload).slice(0, 200)}`), { code: 'UPSTREAM' })
}

async function readJson(response) {
  const text = await response.text()
  try { return JSON.parse(text) } catch { return { raw: text.slice(0, 500) } }
}

/**
 * 读取上游模型清单，只保留白名单条目（用于将来上游改名时能及时发现）。
 * 这里不做网络请求：白名单来自实测，运行期再拉清单反而会引入不稳定。
 */
export function listFreeModels() {
  return FREE_MODELS.map(row => ({ ...row }))
}

/** 组装 OpenAI 兼容请求体。消息转换复用 CodeArts 渠道已验证的实现。 */
export function buildKiloBody(options) {
  const model = typeof options.model === 'string' ? options.model : (options.model?.id ?? '')
  const stats = { droppedToolResults: 0 }
  const body = {
    model,
    messages: serializeMessages(options.messages, options.system, stats),
    stream: true,
  }
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop

  // ── 思考默认打开 ──────────────────────────────────────────────────────
  // 关思考的模型明显变笨（用户实测反馈），所以默认给 medium。代价是思考会
  // 吃输出预算：实测 nemotron lightning 在 512 token 下 medium/high 会把正文
  // 全部吃光（content 空），low 才能出正文；openrouter/free 与 kilo-auto/small
  // 各档都正常。因此对这一个模型单独降到 low，其余保持 medium。
  //
  // 同时抬高思考请求的最低预算：DSH 有时只给几十 token，思考一来正文就没了。
  // 只有用户显式关思考（off/none）才按原预算走。
  const explicit = typeof options.reasoningEffort === 'string' ? options.reasoningEffort : ''
  const thinking = explicit !== 'off' && explicit !== 'none'
  let effort = explicit === 'on' || explicit === '' ? 'medium' : explicit
  if (model === 'nvidia/nemotron-3.5-lightning:free' && effort !== 'low') effort = 'low'
  body.reasoning = { effort: thinking ? effort : 'none' }

  const askedTokens = Number(options.maxTokens)
  const budget = askedTokens > 0
    ? Math.max(Math.floor(askedTokens), thinking ? THINKING_TOKEN_FLOOR : 0)
    : (thinking ? THINKING_TOKEN_FLOOR : 0)
  // max_tokens: 0 上游会拒；关思考且没给预算时干脆不设这个字段，让服务端用默认值。
  if (budget > 0) body.max_tokens = budget
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
    body.tool_choice = 'auto'
  }
  return body
}

/**
 * Kilo SSE → DSH 事件流。
 *
 * 与 CodeArts 的差别：thinking 模型把正文放在 `reasoning` / `reasoning_details`
 * 而不是 `reasoning_content`，两种都收；usage 一次在末帧给出；工具调用是标准
 * `tool_calls` 通道，分片 id 只出现在首帧。
 */
export async function* parseKiloStream(response, { model, signal } = {}) {
  if (!response.body) {
    throw Object.assign(new Error('Kilo 直连：响应无正文'), { code: 'EMPTY_RESPONSE' })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed = false
  let nextIndex = 0
  let textBlock
  let reasoningBlock
  let finishReason
  let usage
  let sawData = false
  const toolCalls = new Map()
  const toolIds = new Map()
  const toolOrder = []

  function* emitText(text) {
    if (typeof text !== 'string' || text === '') return
    if (textBlock === undefined) {
      textBlock = { index: nextIndex++, text: '' }
      yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
    }
    textBlock.text += text
    yield { type: 'text-delta', index: textBlock.index, text }
  }

  function* emitReasoning(text) {
    if (typeof text !== 'string' || text === '') return
    if (reasoningBlock === undefined) {
      reasoningBlock = { index: nextIndex++, text: '' }
      yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
    }
    reasoningBlock.text += text
    yield { type: 'reasoning-delta', index: reasoningBlock.index, text }
  }

  function* emitCall(call) {
    if (typeof call?.name !== 'string' || call.name === '') return
    const entry = {
      index: nextIndex++,
      id: typeof call.id === 'string' && call.id !== '' ? call.id : `kilo-${randomBytes(8).toString('hex')}`,
      name: call.name,
      args: typeof call.arguments === 'string' && call.arguments !== '' ? call.arguments : '{}',
    }
    toolOrder.push(entry.index)
    yield { type: 'block-start', index: entry.index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: entry.index, id: entry.id, name: entry.name, argumentsDelta: entry.args }
  }

  try {
    while (true) {
      if (signal?.aborted === true) throw new Error('Kilo 直连请求已取消')
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let cut
      while ((cut = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, cut).trim()
        buffer = buffer.slice(cut + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          await reader.cancel().catch(() => {})
          completed = true
          break
        }
        sawData = true
        let data
        try { data = JSON.parse(payload) } catch { continue }

        if (data.error) {
          throw wallError(Number(data.error.status) || 0, data)
        }

        const delta = data.choices?.[0]?.delta
        const reason = data.choices?.[0]?.finish_reason
        if (typeof reason === 'string' && reason !== '') finishReason = reason

        if (delta !== undefined) {
          const thinking = delta.reasoning ?? delta.reasoning_content
          if (typeof thinking === 'string' && thinking !== '') yield* emitReasoning(thinking)
          if (Array.isArray(delta.reasoning_details)) {
            for (const detail of delta.reasoning_details) {
              if (detail?.type === 'reasoning.text' && typeof detail.text === 'string' && detail.text !== '') {
                // reasoning_details 是 reasoning 的镜像；只在 reasoning 缺失时用它，避免重复
                if (typeof delta.reasoning !== 'string') yield* emitReasoning(detail.text)
              }
            }
          }
          if (typeof delta.content === 'string' && delta.content !== '') yield* emitText(delta.content)

          for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            const wireIndex = call.index ?? 0
            if (typeof call.id === 'string' && call.id !== '') toolIds.set(wireIndex, call.id)
            const id = toolIds.get(wireIndex) ?? `call_${wireIndex}`
            let entry = toolCalls.get(wireIndex)
            if (entry === undefined) {
              entry = { index: nextIndex++, id, name: '', args: '', announced: false }
              toolCalls.set(wireIndex, entry)
            }
            entry.id = id
            if (typeof call.function?.name === 'string' && call.function.name !== '') entry.name = call.function.name
            entry.args += String(call.function?.arguments ?? '')
            if (!entry.announced) {
              if (entry.name === '') continue
              entry.announced = true
              toolOrder.push(entry.index)
              yield { type: 'block-start', index: entry.index, blockType: 'tool-call' }
              yield { type: 'tool-call-delta', index: entry.index, id: entry.id, name: entry.name, argumentsDelta: entry.args }
              continue
            }
            yield { type: 'tool-call-delta', index: entry.index, id: entry.id, name: entry.name, argumentsDelta: String(call.function?.arguments ?? '') }
          }
        }

        if (data.usage !== undefined && data.usage !== null) {
          const prompt = Number(data.usage.prompt_tokens) || 0
          const cached = Number(data.usage.prompt_tokens_details?.cached_tokens) || 0
          const reasoning = Number(data.usage.completion_tokens_details?.reasoning_tokens) || 0
          usage = {
            inputTokens: Math.max(0, prompt - cached),
            outputTokens: Number(data.usage.completion_tokens) || 0,
            ...(cached > 0 ? { cacheReadTokens: cached } : {}),
            ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
          }
        }
      }
      if (completed) break
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* 已 cancel */ }
  }

  if (!sawData) {
    throw Object.assign(new Error('Kilo 直连：响应里没有任何数据帧'), { code: 'EMPTY_RESPONSE' })
  }

  const blocks = []
  if (reasoningBlock !== undefined && reasoningBlock.text.trim() !== '') {
    blocks.push({ index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } })
  }
  if (textBlock !== undefined && textBlock.text !== '') {
    blocks.push({ index: textBlock.index, block: { type: 'text', text: textBlock.text } })
  }
  for (const entry of [...toolCalls.values()].filter(row => row.announced).sort((a, b) => a.index - b.index)) {
    blocks.push({
      index: entry.index,
      block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.args === '' ? '{}' : entry.args },
    })
  }
  blocks.sort((a, b) => a.index - b.index)
  for (const row of blocks) yield { type: 'block-end', index: row.index, block: row.block }
  if (usage !== undefined) yield { type: 'usage', usage }

  const kind = finishReason === 'length'
    ? 'max-tokens'
    : toolOrder.length > 0 || finishReason === 'tool_calls' ? 'tool-calls' : 'stop'
  yield { type: 'finish', reason: { kind } }
}

/** 单次直连请求（非流式只用于自检；对话一律走 stream）。 */
export async function probeChat(model) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'dsh-kilo-direct/1.0' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
        stream: false,
        max_tokens: 16,
      }),
      signal: ctrl.signal,
    })
    const json = await readJson(response)
    if (!response.ok) throw wallError(response.status, json)
    const message = json.choices?.[0]?.message ?? {}
    return { ok: true, model, answer: String(message.content ?? message.reasoning ?? '').slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

/** 上游清单探测：只用于诊断接口，不参与模型选择。 */
export async function probeCatalog() {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(MODELS_URL, { headers: { 'user-agent': 'dsh-kilo-direct/1.0' }, signal: ctrl.signal })
    const json = await readJson(response)
    return { ok: response.ok, total: Array.isArray(json.data) ? json.data.length : 0 }
  } finally {
    clearTimeout(timer)
  }
}

/** 聊天渠道的适配器：实现 DSH 要求的五个方法 + 图片计价。 */
export class KiloDirectAdapter {
  constructor({ logger, fetcher = fetch } = {}) {
    this.logger = logger ?? console
    this.fetcher = fetcher
  }

  providerInfo(provider) {
    return { id: provider, name: 'Kilo 免费池（直连）' }
  }

  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: Object.freeze(['TRANSPORT', 'SERVER', 'TIMEOUT', 'RATE_LIMITED']),
      initialDelayMs: 1200,
      maxDelayMs: 8000,
      jitterRatio: 0.2,
    })
  }

  /** 同步计价：缺了它会在上下文压缩阶段抛 TypeError（见 image-pricing.js）。 */
  imageRequestPricing() {
    return FALLBACK_IMAGE_PRICING
  }

  async listModels(provider) {
    return FREE_MODELS.map(row => ({
      provider,
      id: row.id,
      name: row.name,
      inputModalities: row.vision ? ['text', 'image'] : ['text'],
    }))
  }

  async resolveModel(provider, model) {
    const id = typeof model === 'string' ? model : (model?.id ?? '')
    const row = modelRow(id)
    return {
      provider,
      id: row.id,
      name: row.name,
      inputModalities: row.vision ? ['text', 'image'] : ['text'],
      context: { contextWindow: row.contextWindow },
      defaultMaxTokens: DEFAULT_MAX_OUTPUT,
    }
  }

  async prepareCall(provider, model) {
    const info = await this.resolveModel(provider, model)
    return { model: info, stream: options => this.stream(options) }
  }

  async *stream(options) {
    const requested = typeof options.model === 'string' ? options.model : (options.model?.id ?? '')
    const body = buildKiloBody({ ...options, model: requested })

    const ctrl = new AbortController()
    const relay = () => ctrl.abort()
    options.signal?.addEventListener?.('abort', relay, { once: true })
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    let response
    try {
      response = await this.fetcher(CHAT_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'dsh-kilo-direct/1.0',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (error) {
      throw Object.assign(new Error(`Kilo 直连网络错误：${error?.message ?? error}`), { code: 'TRANSPORT' })
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      const json = await readJson(response)
      throw wallError(response.status, json)
    }

    try {
      yield* parseKiloStream(response, { model: requested, signal: options.signal })
    } finally {
      options.signal?.removeEventListener?.('abort', relay)
    }
  }
}
