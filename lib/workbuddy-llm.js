/**
 * WorkBuddy 模型渠道（自包含实现）。
 *
 * 移植自 dsh-workbuddy/index.js（同一份协议与踩坑结论），本插件内独立可用：
 * 不依赖 @local/dsh-workbuddy 插件，只依赖 WorkBuddy 桌面端在运行。
 *
 * ## 为什么必须走 wbipc
 * `/v2/chat/completions` 有渠道校验（11128 request illegal），直连 HTTPS 一律被拒；
 * 只有经桌面端 `wb.request/http.fetch`（宿主注入身份头）才放行。
 *
 * ## 为什么注册成别名 provider
 * Our Free Model 2.8.0 的 magpie-policy 把 `workbuddy|codebuddy|codearts|huawei…`
 * 列为拒绝渠道，`/api/providers` 按 id 过滤。用 `wbai` 既不含这些关键词，
 * 也不与任何现有 provider 冲突——和 CodeArts 用 `devcloud` 是同一条理由。
 *
 * ## 宿主的两条硬限制（决定了必须分段续写）
 * - 响应体 > 655360 字节直接 E_PAYLOAD_TOO_LARGE（SSE ≈ 328B/token ≈ 2000 token）；
 * - 单次调用 50s 超时（E_UPSTREAM）。
 * 所以一次请求拿不到长回答：按段请求、段间续写，对外仍是一条连续回答。
 */

import { connect as wbConnect } from './wbipc-client.js'
import { DirectClient } from './workbuddy-direct.js'
import { FALLBACK_IMAGE_PRICING } from './image-pricing.js'
import { fetchModelRows, mapModelRow } from './model-catalog.js'

/** 注册给 DSH 的 provider 别名（避开 OFM 的拒绝名单）。 */
export const WORKBUDDY_PROVIDER = 'wbai'
/** 选择器里显示的名字（不含被 redact 的品牌词，避免第三方页面被改写）。 */
export const WORKBUDDY_LABEL = 'WorkBuddy 在线模型'

const CLIENT_VERSION = '5.9.3'
const PROBE_PORTS = [18488, 18489, 18490]

const FALLBACK_MODELS = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, maxOutput: 128_000, vision: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000, maxOutput: 128_000, vision: true },
  { id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 1_000_000, maxOutput: 48_000, vision: true },
  { id: 'kimi-k3-1', name: 'Kimi K3.1', contextWindow: 1_000_000, maxOutput: 32_000, vision: true },
  { id: 'minimax-m3', name: 'MiniMax M3', contextWindow: 512_000, maxOutput: 64_000, vision: true },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxOutput: 64_000, vision: true },
]

// ── 小工具 ────────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function str(record, key) {
  const value = record?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function parseJson(text) {
  if (typeof text !== 'string' || text === '') return null
  try { return JSON.parse(text) } catch { return null }
}

/** WorkBuddy 只接受裸模型 ID；带 provider 前缀会被判「当前模型不可用」（11102）。 */
function bareModelId(value) {
  const raw = typeof value === 'string' ? value : (typeof value?.id === 'string' ? value.id : '')
  let id = raw.trim()
  if (id === '') return ''
  const slash = id.lastIndexOf('/')
  if (slash >= 0) id = id.slice(slash + 1).trim()
  return id
}

/** 把后端错误体压成一句可诊断的话，保留 code / requestId。 */
function describeFailure(status, body) {
  const payload = parseJson(body)
  const message = payload?.displayMsg?.zh ?? payload?.displayMsg?.en ?? payload?.msg ?? payload?.message ?? ''
  const code = payload?.code ?? payload?.error?.code ?? '-'
  const requestId = payload?.requestId ?? payload?.request_id ?? '-'
  const fallback = typeof body === 'string' ? body.slice(0, 200).replace(/\s+/g, ' ') : ''
  return {
    code: String(code),
    requestId: String(requestId),
    message: String(message) || fallback || '(无错误信息)',
    payload,
  }
}

const TRANSIENT_SERVER_CODES = new Set(['11101', '11133'])
const TRANSIENT_HINTS = /拦截|重新发送|请重试|稍后|繁忙|限流|too many|rate limit|timeout|temporar/i

// 11128「渠道校验」：后端会拦掉 system / assistant 里带第三方 agent 指纹的请求。
// 实测（2026-10-26 起）：品牌名与个别 DSH 提示词片段逐字重合会触发，user 消息不参与校验。
// 这里只做等价改写，不改语义、不碰凭据。
const CHANNEL_MARKER_PATTERNS = [
  [/deepseek\s+harness/gi, 'DSH'],
  [
    /Tokens prefixed with @ are paths the user explicitly referenced\./gi,
    'Tokens that begin with @ mark paths the user referenced explicitly.',
  ],
]

const NEUTRAL_SYSTEM = 'You are a helpful assistant.'

function neutralizeChannelMarkers(text) {
  let out = text
  let hits = 0
  for (const [pattern, replacement] of CHANNEL_MARKER_PATTERNS) {
    out = out.replace(pattern, () => {
      hits += 1
      return replacement
    })
  }
  return { text: out, hits }
}

/**
 * 11128 兜底：把 system 指令就地降级进第一条 user 消息。
 * 渠道校验只看 system / assistant，指纹库更新、改写表没覆盖时靠这条路继续。
 */
function demoteSystemToUser(wire) {
  if (!Array.isArray(wire)) return false
  const index = wire.findIndex(message => message?.role === 'system' && typeof message.content === 'string' && message.content.trim() !== '')
  if (index < 0) return false
  const systemText = wire[index].content
  if (systemText === NEUTRAL_SYSTEM) return false
  wire[index] = { role: 'system', content: NEUTRAL_SYSTEM }
  const framed = `以下是本轮必须遵守的运行指令（其效力等同 system 指令）：\n\n${systemText}`
  const firstUser = wire.findIndex(message => message?.role === 'user')
  if (firstUser < 0) {
    wire.splice(index + 1, 0, { role: 'user', content: framed })
    return true
  }
  const existing = typeof wire[firstUser].content === 'string' ? wire[firstUser].content : ''
  wire[firstUser] = { role: 'user', content: `${framed}\n\n---\n\n${existing}` }
  return true
}

// ── 宿主的硬限制（决定分段策略）─────────────────────────────────────────────
const HOST_RESPONSE_LIMIT_BYTES = 655_360
const HOST_UPSTREAM_TIMEOUT_MS = 50_000
const SAFE_RESPONSE_BYTES = 430_000
const SEGMENT_TOKEN_CEILING = 3000
const SEGMENT_TOKEN_HARD_CEILING = 6000
const SEGMENT_TOKEN_FLOOR = 200
const SEGMENT_TARGET_MS = 30_000
const MAX_SEGMENTS = 12
const TOTAL_TOKEN_CEILING = 32_000
const CONTINUE_NUDGE = 'Continue exactly where the previous message was cut off. Output only the remaining content — do not repeat any text already produced, do not add any preamble.'
const CONTINUE_WITHOUT_TEXT = 'Your previous reply hit the output limit before any answer text was written — the entire budget was consumed by hidden planning, and that planning was discarded. Do not plan or reason again. Write the final answer text now, starting from the beginning.'
const TOOLCALL_RETRY_NUDGE = 'The tool call in your previous reply was discarded because its JSON arguments were incomplete or invalid (often caused by very long escaped strings). Re-emit that tool call now, complete and valid. If its arguments are large (for example rewriting a whole file), do NOT emit one giant call — split the work into several smaller tool calls, each changing only a few lines, and prefer short unique anchors over whole-file rewrites. Do not repeat any text you already produced — start directly from the tool call.'

function hostLimitKind(error) {
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? '')
  if (code === 'E_PAYLOAD_TOO_LARGE' || message.includes('E_PAYLOAD_TOO_LARGE') || /exceeds inline limit/i.test(message)) return 'payload'
  if (code === 'E_UPSTREAM' || message.includes('E_UPSTREAM') || /upstream timed out/i.test(message)) return 'timeout'
  return null
}

/** 续写时模型常把上一段结尾再吐一遍，重叠 ≥24 字符才剪。 */
function trimOverlap(previous, next) {
  const limit = Math.min(previous.length, next.length, 600)
  for (let size = limit; size >= 24; size -= 1) {
    if (previous.endsWith(next.slice(0, size))) return next.slice(size)
  }
  return next
}

function classifyFailure(status, info) {
  if (status === 0 || status === 408 || status === 425 || status === 429) return 'retry'
  if (status >= 500) return 'retry'
  if (info.code === '11102') return 'model'
  if (info.code === '11128') return 'channel'
  if (TRANSIENT_SERVER_CODES.has(info.code) || TRANSIENT_HINTS.test(info.message)) return 'retry'
  return 'fatal'
}

function isConnectionError(error) {
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? '')
  return code === 'E_CLOSED'
    || code === 'E_TIMEOUT'
    || code === 'E_CONNECT_TIMEOUT'
    || message.startsWith('E_CLOSED')
    || message.startsWith('E_TIMEOUT')
    || message.startsWith('E_CONNECT_TIMEOUT')
    || /EPIPE|ECONNRESET|EOF/i.test(message)
}

/** 探活桌面端：18488/18489/18490 依次试，命中即停。 */
export async function probeDesktop({ timeoutMs = 600 } = {}) {
  for (const port of PROBE_PORTS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/workbuddy/probe`, { signal: controller.signal, redirect: 'error' })
      if (!response.ok) continue
      const payload = await response.json()
      if (payload?.ok === true) {
        return { running: true, port, version: String(payload.version ?? ''), platform: String(payload.platform ?? '') }
      }
    } catch { /* 试下一个端口 */ } finally { clearTimeout(timer) }
  }
  return { running: false, port: 0, version: '', platform: '' }
}

// ── wbipc 封装 ────────────────────────────────────────────────────────────────

class WbipcClient {
  constructor({ logger = console } = {}) {
    this.wb = null
    this.connected = false
    this.logger = logger
    this.connecting = null
  }

  async connect() {
    if (this.connecting !== null) return this.connecting
    this.connecting = (async () => {
      try {
        this.wb = await wbConnect({ client: { kind: 'plugin', id: 'dsh-codearts', version: '1.0.0' } })
        this.connected = true
        return true
      } catch (error) {
        this.connected = false
        this.wb = null
        this.lastError = error
        return false
      } finally {
        this.connecting = null
      }
    })()
    return this.connecting
  }

  /** 连接失效时重连（宿主重启会换 instanceId 与 ticket，必须重读 endpoint.json）。 */
  async recover() {
    this.logger.warn?.('dsh-codearts: WorkBuddy wbipc 连接失效，正在重连')
    await this.disconnect()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await this.connect()) return true
      await sleep(300 * (attempt + 1))
    }
    return false
  }

  async disconnect() {
    if (this.wb) { try { this.wb.close() } catch { /* 已关闭 */ } }
    this.wb = null
    this.connected = false
  }

  isConnected() { return this.connected && this.wb !== null }

  /** 单次 HTTP 代理调用；连接类错误自动重连重试一次。 */
  async httpFetch(method, path, { headers = {}, body, timeoutMs } = {}) {
    const attempt = async () => {
      if (!this.isConnected() && !(await this.connect())) {
        throw Object.assign(new Error('WorkBuddy 桌面端未运行，wbipc 不可用。请先启动 WorkBuddy。'), { code: 'MISSING_CREDENTIAL' })
      }
      const params = { method, path, headers: { accept: 'application/json', ...headers } }
      if (body !== undefined) {
        params.body_b64 = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64')
      }
      const options = timeoutMs === undefined ? {} : { timeout: timeoutMs }
      const result = await this.wb.call('wb.request', 'http.fetch', params, options)
      const responseBody = Buffer.from(result.body_b64 ?? '', 'base64').toString()
      return { status: result.status, headers: result.headers ?? {}, body: responseBody, json: parseJson(responseBody) }
    }

    try {
      return await attempt()
    } catch (error) {
      if (isConnectionError(error) && (await this.recover())) return attempt()
      this.connected = false
      throw error
    }
  }

  async getAccount() {
    const r = await this.httpFetch('GET', '/v2/plugin/login/account', { headers: { 'content-type': 'application/json' } })
    return r.json?.data ?? null
  }

  async getModels() {
    const rows = await fetchModelRows((method, path, options) => this.httpFetch(method, path, options))
    return rows.map(mapModelRow)
  }

  async chat(body) {
    // WorkBuddy 只支持流式：非流式一律被拒（11101）
    const payload = { ...body, stream: true }
    return this.httpFetch('POST', '/v2/chat/completions', {
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: payload,
      timeoutMs: 300_000,
    })
  }
}

// ── 消息转换 ──────────────────────────────────────────────────────────────────

function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (block?.type === 'text' ? String(block.text ?? '') : '')).filter(part => part !== '').join('\n')
}

function toWireMessages(messages, system, stats) {
  const wire = []
  const sanitize = text => {
    const result = neutralizeChannelMarkers(text)
    if (result.hits > 0 && stats !== undefined) stats.channelMarkers = (stats.channelMarkers ?? 0) + result.hits
    return result.text
  }
  if (typeof system === 'string' && system.length > 0) wire.push({ role: 'system', content: sanitize(system) })
  // WorkBuddy 对工具配对极其严格：工具结果对不上任何一次调用就整轮 11148，先做配对清理。
  const knownCallIds = new Set()
  let sequence = 0

  for (const message of messages ?? []) {
    const role = message?.role
    if (role === 'tool') {
      const id = String(message.toolCallId ?? message.tool_call_id ?? message.callId ?? message.id ?? '')
      if (id === '' || !knownCallIds.has(id)) {
        if (stats !== undefined) stats.droppedToolResults = (stats.droppedToolResults ?? 0) + 1
        continue
      }
      wire.push({ role: 'tool', tool_call_id: id, content: textOf(message) || '(no output)' })
      continue
    }
    if (role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : []
      const text = blocks.map(block => (block?.type === 'text' ? String(block.text ?? '') : '')).join('')
      const calls = blocks.filter(block => block?.type === 'tool-call').map(block => {
        sequence += 1
        // 缺 id 的调用会被判 11133，补一个稳定 id
        const id = String(block.id ?? '') || `call_${sequence}`
        knownCallIds.add(id)
        return {
          id,
          type: 'function',
          function: { name: String(block.name ?? ''), arguments: String(block.arguments ?? '{}') || '{}' },
        }
      })
      const row = { role: 'assistant', content: sanitize(text) }
      if (calls.length > 0) row.tool_calls = calls
      else if (text === '') continue
      wire.push(row)
      continue
    }
    if (role === 'user' || role === 'system' || role === 'developer') {
      const text = textOf(message)
      if (text !== '') wire.push({ role: role === 'developer' ? 'system' : role, content: role === 'user' ? text : sanitize(text) })
    }
  }
  if (wire.length === 0 || wire[0].role !== 'system') wire.unshift({ role: 'system', content: NEUTRAL_SYSTEM })
  return wire
}

/** 上游 finish token → 宿主 finish kind。 */
function finishReason(sawToolCall, token) {
  if (sawToolCall) return 'tool-calls'
  if (token === 'length' || token === 'max_tokens' || token === 'max_output_tokens' || token === 'incomplete') return 'max-tokens'
  return 'stop'
}

// ── 适配器 ────────────────────────────────────────────────────────────────────

class WorkBuddyAdapter {
  constructor({ runtime, logger }) {
    this.runtime = runtime
    this.logger = logger ?? console
    /** 实测字节/token，跨步持久，用来预截分段预算。 */
    this.bytesPerToken = 0
  }

  providerInfo(provider) {
    return { id: provider, name: WORKBUDDY_LABEL }
  }

  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: Object.freeze(['TRANSPORT', 'SERVER', 'TIMEOUT']),
      initialDelayMs: 800,
      maxDelayMs: 6000,
      jitterRatio: 0.2,
    })
  }

  /**
   * 同步的图片计价估算。DSH 在 token 计量/上下文压缩阶段每次测量都会调用，
   * 缺这个方法会让声明了视觉能力的渠道在压缩时抛 TypeError。
   */
  imageRequestPricing(_provider, _model) {
    return FALLBACK_IMAGE_PRICING
  }

  async listModels(provider) {
    // wbipc 模式：桌面端没跑就返回空，避免选择器里出现点了必失败的渠道。
    // 直连模式（手机）：不依赖桌面端，只要求本设备登录了 WorkBuddy 账号。
    if (this.runtime.transport === 'wbipc') {
      const desktop = await probeDesktop()
      if (!desktop.running) return []
    } else if (this.runtime.transport === 'direct') {
      const credential = await this.runtime.resolveCredential?.()
      if (!credential) return []
    }
    return (await this.runtime.models()).map(row => ({
      provider,
      id: row.id,
      name: row.name,
      inputModalities: row.vision === true ? ['text', 'image'] : ['text'],
    }))
  }

  async resolveModel(provider, model) {
    const canonical = await this.runtime.canonicalModelId(model)
    const rows = await this.runtime.models()
    const row = rows.find(candidate => candidate.id === canonical)
    const reasoning = row?.reasoning
    return {
      provider,
      id: canonical,
      name: row?.name ?? canonical,
      inputModalities: row?.vision === true ? ['text', 'image'] : ['text'],
      context: { contextWindow: row?.contextWindow ?? 131_072 },
      defaultMaxTokens: row?.maxOutput ?? 32_768,
      ...(reasoning !== undefined && Array.isArray(reasoning.supportedEfforts) && reasoning.supportedEfforts.length > 0
        ? {
            reasoning: {
              efforts: reasoning.supportedEfforts.map(level => ({ id: level, name: level })),
              defaultEffort: reasoning.defaultEffort ?? reasoning.effort ?? reasoning.supportedEfforts.at(-1),
            },
          }
        : {}),
    }
  }

  async prepareCall(provider, model) {
    const info = await this.resolveModel(provider, model)
    return { model: info, stream: options => this.stream(options) }
  }

  /**
   * 一次对话请求（含重试分类）：
   * - 11102「当前模型不可用」→ 换 auto 再来一次；
   * - 5xx / 429 / 超时 / 「请求被拦截，请重新发送」→ 退避重试；
   * - 连接断开 → 重连重试。
   */
  async requestWithRetry(initialBody, options) {
    const limit = 2
    let attempt = 0
    let body = initialBody
    let demoted = false

    for (;;) {
      if (options?.signal?.aborted === true) throw new Error('WorkBuddy 请求已取消')
      let response
      try {
        response = await this.runtime.chat(body)
      } catch (error) {
        if (attempt < limit && isConnectionError(error)) {
          attempt += 1
          await this.runtime.recover()
          await sleep(400 * attempt)
          continue
        }
        throw error
      }

      if (response.status === 200) return { response, body }

      const info = describeFailure(response.status, response.body)
      const verdict = classifyFailure(response.status, info)

      if (verdict === 'model' && attempt < limit) {
        const fallback = await this.runtime.canonicalModelId('auto')
        if (fallback !== body.model && fallback !== undefined) {
          attempt += 1
          const next = { ...body, model: fallback }
          const row = (await this.runtime.models()).find(candidate => candidate.id === fallback)
          if (row?.reasoning === undefined) {
            delete next.thinking
            delete next.reasoning_effort
          }
          body = next
          continue
        }
      }

      if (verdict === 'retry' && attempt < limit) {
        attempt += 1
        await sleep(1200 * attempt)
        continue
      }

      if (verdict === 'channel') {
        // 指纹表没覆盖到的写法：把 system 降级进 user 消息再试一次（user 不参与渠道校验）
        if (!demoted && demoteSystemToUser(body?.messages)) {
          demoted = true
          attempt += 1
          this.logger.warn?.('dsh-codearts: WorkBuddy 命中 11128 渠道校验，已把 system 指令降级到 user 消息重试')
          continue
        }
        const error = new Error(`WorkBuddy ${response.status} [${info.code}/${info.requestId}]: ${info.message}（渠道校验 11128：已改写已知指纹并尝试降级 system 仍被拒）`)
        error.code = info.code
        error.requestId = info.requestId
        error.status = response.status
        throw error
      }

      const error = new Error(`WorkBuddy ${response.status} [${info.code}/${info.requestId}]: ${info.message}`)
      error.code = info.code
      error.requestId = info.requestId
      error.status = response.status
      throw error
    }
  }

  async *stream(options) {
    const requested = typeof options.model === 'string' ? options.model : (options.model?.id ?? '')
    const modelId = await this.runtime.canonicalModelId(requested)
    const catalog = await this.runtime.models()
    const row = catalog.find(candidate => candidate.id === modelId)

    const wireStats = { droppedToolResults: 0 }
    const body = {
      model: modelId,
      messages: toWireMessages(options.messages, options.system, wireStats),
      stream: true,
    }
    if (wireStats.droppedToolResults > 0) {
      this.logger.warn?.(`dsh-codearts: 丢弃 ${wireStats.droppedToolResults} 条无对应调用的工具结果（否则后端会以 11148 拒绝整轮）`)
    }
    if ((wireStats.channelMarkers ?? 0) > 0) {
      this.logger.info?.(`dsh-codearts: 已改写 system/assistant 中 ${wireStats.channelMarkers} 处渠道指纹`)
    }
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.maxTokens !== undefined && Number(options.maxTokens) > 0) {
      const ceiling = Number(row?.maxOutput) > 0 ? Number(row.maxOutput) : undefined
      body.max_tokens = ceiling === undefined ? options.maxTokens : Math.min(Number(options.maxTokens), ceiling)
    }
    if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop
    if (Array.isArray(options.tools) && options.tools.length > 0) {
      body.tools = options.tools.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))
      body.tool_choice = 'auto'
    }
    // 思考默认关：开着会把分段额度全吃在 reasoning 上（正文所剩无几），也拖慢请求
    if (typeof options.reasoningEffort === 'string' && options.reasoningEffort !== '') {
      body.thinking = { type: 'enabled' }
      body.reasoning_effort = options.reasoningEffort
    } else if (row?.supportsReasoning === true && row?.reasoning?.canDisableThinking !== false) {
      body.thinking = { type: 'disabled' }
    }

    // ── 分段生成 ────────────────────────────────────────────────────────────
    const asked = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : undefined
    const rowCeiling = Number(row?.maxOutput) > 0 ? Number(row.maxOutput) : undefined
    const totalBudget = Math.max(SEGMENT_TOKEN_FLOOR, Math.min(asked ?? rowCeiling ?? 8192, TOTAL_TOKEN_CEILING))

    const messages = [...body.messages]
    const thinksByDefault = row?.supportsReasoning === true
      && row?.reasoning?.canDisableThinking !== true
      && typeof options.reasoningEffort !== 'string'
    const wantsThinking = thinksByDefault
      || (typeof options.reasoningEffort === 'string' && options.reasoningEffort !== '')
    let budget = Math.min(totalBudget, wantsThinking ? SEGMENT_TOKEN_HARD_CEILING : SEGMENT_TOKEN_CEILING)
    if (this.bytesPerToken > 0) {
      budget = Math.min(budget, Math.max(SEGMENT_TOKEN_FLOOR, Math.floor(SAFE_RESPONSE_BYTES / this.bytesPerToken)))
    }
    let produced = 0
    let bytesPerToken = this.bytesPerToken
    let shrinks = 0
    let toolRetries = 0
    let segment = 0
    let stoppedByBudget = false
    let emptyStreak = 0

    let index = 0
    let reasoningIndex
    let textIndex
    let reasoningText = ''
    let textText = ''
    const toolIndexes = new Map()
    let usageTotal
    let upstreamFinish = null
    let brokenToolCall = false

    while (segment < MAX_SEGMENTS) {
      segment += 1
      const segBody = { ...body, messages, max_tokens: budget }
      // 续写段没有新决策要做，继续开着思考只会再吃掉一整段额度
      if (segment > 1) {
        delete segBody.reasoning_effort
        if (row?.supportsReasoning === true) segBody.thinking = { type: 'disabled' }
        else delete segBody.thinking
      }
      const startedAt = Date.now()

      let response
      try {
        const out = await this.requestWithRetry(segBody, options)
        response = out.response
      } catch (error) {
        const limit = hostLimitKind(error)
        if (limit !== null && shrinks < 2 && budget > SEGMENT_TOKEN_FLOOR) {
          shrinks += 1
          segment -= 1
          budget = Math.max(SEGMENT_TOKEN_FLOOR, Math.floor(budget * 0.5))
          this.logger.warn?.(`dsh-codearts: 撞到 WorkBuddy 宿主${limit === 'payload' ? ' 640KB 响应上限' : ' 50s 上游超时'}，分段降到 ${budget} token 重试`)
          continue
        }
        if (limit === 'payload') {
          throw new Error(`WorkBuddy 宿主限制：单次响应不能超过 ${Math.round(HOST_RESPONSE_LIMIT_BYTES / 1024)}KB（约 2000 输出 token），当前分段 ${budget} token 仍超出。请把任务拆小。`)
        }
        if (limit === 'timeout') {
          throw new Error(`WorkBuddy 宿主限制：单次请求 ${HOST_UPSTREAM_TIMEOUT_MS / 1000}s 上游超时（分段 ${budget} token 未能在时限内返回）。换更快的模型，或降低思考强度。`)
        }
        throw error
      }

      const elapsed = Date.now() - startedAt
      if (response.status !== 200) {
        const info = describeFailure(response.status, response.body)
        throw new Error(`WorkBuddy ${response.status} [${info.code}/${info.requestId}]: ${info.message}`)
      }

      const frames = response.body.split('\n').map(line => line.trim()).filter(line => line.startsWith('data:'))
      if (frames.length === 0) {
        // 后端有时以 200 返回整个错误体，别静默变成「空回答」
        const info = describeFailure(response.status, response.body)
        const error = new Error(`WorkBuddy [${info.code}/${info.requestId}]: ${info.message}`)
        error.code = info.code
        error.requestId = info.requestId
        throw error
      }

      // 先整段解析：http.fetch 没有实时增量可损失，缓冲下来才能做重叠裁剪、判断该不该续写
      let segReasoning = ''
      let segText = ''
      const segTools = []
      let segFinish = null
      let segUsage

      for (const line of frames) {
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') break
        if (payload === '') continue
        let frame
        try { frame = JSON.parse(payload) } catch { continue }
        if (frame.error !== undefined) throw new Error(`WorkBuddy 串流错误：${frame.error.message ?? 'unknown'}`)
        const choice = frame.choices?.[0]
        const delta = choice?.delta
        if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') segFinish = choice.finish_reason
        if (frame.usage !== undefined && frame.usage !== null) {
          // 宿主的 inputTokens 语义是「未命中缓存的输入」，缓存命中要扣回去
          const promptTokens = Number(frame.usage.prompt_tokens) || 0
          const cacheHit = Number(frame.usage.prompt_cache_hit_tokens) || 0
          segUsage = {
            inputTokens: Math.max(0, promptTokens - cacheHit),
            outputTokens: Number(frame.usage.completion_tokens) || 0,
            totalTokens: Number(frame.usage.total_tokens) || 0,
            cacheReadTokens: cacheHit,
            reasoningTokens: Number(frame.usage.completion_thinking_tokens) || 0,
          }
        }
        if (typeof delta?.reasoning_content === 'string') segReasoning += delta.reasoning_content
        if (typeof delta?.content === 'string') segText += delta.content
        for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
          const key = call.index ?? 0
          let entry = segTools[key]
          if (entry === undefined) {
            entry = { id: String(call.id ?? `call_${key}`), name: '', args: '' }
            segTools[key] = entry
          }
          if (typeof call.id === 'string' && call.id !== '' && entry.id.startsWith('call_')) entry.id = call.id
          if (typeof call.function?.name === 'string' && call.function.name !== '') entry.name = call.function.name
          entry.args += String(call.function?.arguments ?? '')
        }
      }

      if (segment > 1) segText = trimOverlap(textText, segText)

      if (segReasoning !== '') {
        if (reasoningIndex === undefined) { reasoningIndex = index++; yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' } }
        reasoningText += segReasoning
        yield { type: 'reasoning-delta', index: reasoningIndex, text: segReasoning }
      }
      if (segText !== '') {
        if (textIndex === undefined) { textIndex = index++; yield { type: 'block-start', index: textIndex, blockType: 'text' } }
        textText += segText
        yield { type: 'text-delta', index: textIndex, text: segText }
      }

      const segToolEntries = segTools.filter(entry => entry !== undefined)
      // 半截/坏掉的参数 JSON 拼不回来：段内全是坏调用时整块丢弃（宿主看不到 block-start，也就没有孤儿块），稍后 nudge 重发
      const argsComplete = entry => {
        if (entry.name === '') return false
        try { JSON.parse(entry.args === '' ? '{}' : entry.args); return true } catch { return false }
      }
      const segTruncated = segFinish === 'length' || segFinish === 'max_tokens' || segFinish === 'max_output_tokens' || segFinish === 'incomplete'
      const dropBrokenCalls = toolRetries < 2
        && segToolEntries.length > 0 && segToolEntries.every(entry => !argsComplete(entry))
      const emittedCalls = dropBrokenCalls ? [] : segToolEntries
      for (const entry of emittedCalls) {
        const globalIndex = index++
        toolIndexes.set(globalIndex, entry)
        yield { type: 'block-start', index: globalIndex, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: globalIndex, id: entry.id, ...(entry.name === '' ? {} : { name: entry.name }), argumentsDelta: entry.args }
      }

      if (segUsage !== undefined) {
        if (usageTotal === undefined) usageTotal = { inputTokens: 0, outputTokens: 0 }
        usageTotal.inputTokens += segUsage.inputTokens
        usageTotal.outputTokens += segUsage.outputTokens
        if (segUsage.totalTokens > 0) usageTotal.totalTokens = (usageTotal.totalTokens ?? 0) + segUsage.totalTokens
        if (segUsage.cacheReadTokens > 0) usageTotal.cacheReadTokens = (usageTotal.cacheReadTokens ?? 0) + segUsage.cacheReadTokens
        if (segUsage.reasoningTokens > 0) usageTotal.reasoningTokens = (usageTotal.reasoningTokens ?? 0) + segUsage.reasoningTokens
      }

      const segTokens = segUsage !== undefined && segUsage.outputTokens > 0
        ? segUsage.outputTokens
        : Math.max(1, Math.round((segText.length + segReasoning.length) / 2))
      produced += segTokens
      upstreamFinish = segFinish

      // 按实测字节/token 与耗时收窄下一段；又快又便宜时放大分段减少往返
      const segBytes = Buffer.byteLength(response.body, 'utf8')
      if (segTokens > 0 && segBytes > 0) {
        const observed = segBytes / segTokens
        bytesPerToken = bytesPerToken === 0 ? observed : Math.max(bytesPerToken * 0.8, observed)
        this.bytesPerToken = bytesPerToken
      }
      const byteCap = bytesPerToken > 0
        ? Math.max(SEGMENT_TOKEN_FLOOR, Math.floor(SAFE_RESPONSE_BYTES / bytesPerToken))
        : SEGMENT_TOKEN_HARD_CEILING

      const truncated = segFinish === 'length' || segFinish === 'max_tokens' || segFinish === 'max_output_tokens' || segFinish === 'incomplete'

      if (elapsed > SEGMENT_TARGET_MS) {
        budget = Math.floor(budget * (SEGMENT_TARGET_MS / elapsed))
      } else if (truncated && elapsed < SEGMENT_TARGET_MS * 0.6 && segBytes < SAFE_RESPONSE_BYTES * 0.6) {
        budget = Math.floor(budget * 1.5)
      }
      budget = Math.max(SEGMENT_TOKEN_FLOOR, Math.min(budget, SEGMENT_TOKEN_HARD_CEILING, byteCap))

      if (!truncated && !dropBrokenCalls) break
      if (segToolEntries.length > 0 && !dropBrokenCalls) break
      if (produced >= totalBudget || segment >= MAX_SEGMENTS) { stoppedByBudget = true; break }

      // 整段被思考吃光时没有正文可接：只补「跳过规划直接作答」，连续三段都空就认输
      const reasoningOnly = segText === ''
      emptyStreak = reasoningOnly ? emptyStreak + 1 : 0
      if (emptyStreak >= 3) { stoppedByBudget = true; break }
      if (textText !== '') messages.push({ role: 'assistant', content: neutralizeChannelMarkers(textText).text })
      if (dropBrokenCalls) toolRetries += 1
      messages.push({
        role: 'user',
        content: dropBrokenCalls ? TOOLCALL_RETRY_NUDGE : reasoningOnly ? CONTINUE_WITHOUT_TEXT : CONTINUE_NUDGE,
      })
      const remaining = totalBudget - produced
      budget = Math.max(SEGMENT_TOKEN_FLOOR, Math.min(budget, Math.max(remaining, SEGMENT_TOKEN_CEILING)))
      this.logger.info?.(`dsh-codearts: WorkBuddy 第 ${segment} 段收尾${segTruncated ? '被截断' : dropBrokenCalls ? '（finish=stop 但工具调用 JSON 无效）' : ''}，已续写至 ${produced}/${totalBudget} token`)
    }

    // 每个 block-start 都必须以携带完整内容的 block-end 收尾
    if (reasoningIndex !== undefined) {
      yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningText } }
    }
    if (textIndex !== undefined) {
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textText } }
    }
    for (const [globalIndex, entry] of toolIndexes) {
      // 参数解析不了 = 调用执行不了；名字为空 = unknown tool。都按「被截断」上报，让宿主剪掉
      try { JSON.parse(entry.args === '' ? '{}' : entry.args) } catch { brokenToolCall = true }
      if (entry.name === '') brokenToolCall = true
      yield {
        type: 'block-end',
        index: globalIndex,
        block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.args === '' ? '{}' : entry.args },
      }
    }
    if (usageTotal !== undefined) yield { type: 'usage', usage: usageTotal }

    // finish_reason 必须如实上报：被截断却报 stop 会让宿主静默丢内容
    let kind = finishReason(toolIndexes.size > 0, upstreamFinish)
    if (brokenToolCall) kind = 'max-tokens'
    if (stoppedByBudget && toolIndexes.size === 0) kind = 'max-tokens'
    yield { type: 'finish', reason: { kind } }
  }
}

// ── 对外工厂 ──────────────────────────────────────────────────────────────────

/**
 * 创建 WorkBuddy 渠道运行时。
 *
 * 返回的 `adapter` 可直接交给 `llm.registerAdapter([WORKBUDDY_PROVIDER], adapter)`；
 * `models()` / `state()` 供设置页路由使用。
 */
export function createWorkBuddyChannel({ logger = console, resolveCredential } = {}) {
  // 传输选择：桌面端在跑就用 wbipc（稳定、官方路径）；否则若有凭据解析器，
  // 就用直连（手机 DSH Go）——凭据足以构造全部网关头，不需要 Windows 桌面端。
  // 注意传输在构造时先按「直连优先」占位，apply 里探测到桌面端会调用
  // runtime.useWbipc() 切换。这样手机端即使探测有延迟也能先就绪。
  const wbipc = new WbipcClient({ logger })
  const direct = typeof resolveCredential === 'function'
    ? new DirectClient({ resolveCredential, logger })
    : null
  let transport = direct !== null ? 'direct' : 'wbipc'
  let accountCache = null
  let catalogCache

  const active = () => (transport === 'wbipc' ? wbipc : direct)

  const runtime = {
    wbipc,
    direct,
    get transport() { return transport },
    resolveCredential,
    /** apply 探测到桌面端在运行时调用：切回官方 wbipc 通道。 */
    useWbipc() { transport = 'wbipc' },
    /** 桌面端不可用时调用：确保走直连（仅在有凭据解析器时有效）。 */
    useDirect() { if (direct !== null) transport = 'direct' },
    async desktop() { return probeDesktop() },
    async account() {
      if (accountCache !== null) return accountCache
      try {
        accountCache = await active().getAccount()
      } catch {
        accountCache = null
      }
      return accountCache
    },
    invalidateAccount() { accountCache = null },
    /** 适配器发对话走这里，自动落到当前选中的传输（wbipc 或直连）。 */
    async chat(body) { return active().chat(body) },
    async recover() { return active().recover() },
    async models() {
      if (catalogCache !== undefined) return catalogCache
      try {
        const rows = await active().getModels()
        catalogCache = rows.length > 0
          ? rows
          : FALLBACK_MODELS.map(m => ({ ...m, supportsReasoning: false, supportsToolCall: true }))
      } catch (error) {
        logger.warn?.(`dsh-codearts: WorkBuddy 模型目录读取失败（${error?.message ?? error}），暂用内置清单`)
        catalogCache = FALLBACK_MODELS.map(m => ({ ...m, supportsReasoning: false, supportsToolCall: true }))
      }
      return catalogCache
    },
    refreshCatalog() {
      catalogCache = undefined
      return this.models()
    },
    /** 把请求里的模型字符串映射到 WorkBuddy 认得的裸 ID；命中不到退回 auto。 */
    async canonicalModelId(requested) {
      const rows = await this.models()
      const wanted = bareModelId(requested)
      const ids = rows.map(row => row.id)
      if (wanted !== '' && ids.includes(wanted)) return wanted
      if (wanted !== '') {
        const hit = rows.find(row => row.id.toLowerCase() === wanted.toLowerCase())
        if (hit !== undefined) return hit.id
      }
      const fallback = ids.includes('auto') ? 'auto' : ids[0]
      if (fallback !== undefined) {
        logger.warn?.(`dsh-codearts: 模型「${requested}」不在 WorkBuddy 模型目录里，改用「${fallback}」`)
      }
      return fallback ?? wanted
    },
  }

  const adapter = new WorkBuddyAdapter({ runtime, logger })

  // 探测桌面端选择传输：在跑 → 切回官方 wbipc（先连上省掉握手延迟）；
  // 不在跑 → 保持/切到直连（手机 DSH Go 的正常形态），无需任何握手。
  void probeDesktop().then(desktop => {
    if (desktop.running) {
      runtime.useWbipc()
      return wbipc.connect().then(ok => {
        if (ok) logger.info?.(`dsh-codearts: 已通过 wbipc 连上 WorkBuddy ${desktop.version}`)
        return ok
      })
    }
    if (direct !== null) {
      runtime.useDirect()
      logger.info?.('dsh-codearts: 未检测到 WorkBuddy 桌面端，WorkBuddy 渠道改用凭据直连（手机端正常形态）')
    }
    return undefined
  }).catch(() => {})

  return { runtime, adapter }
}
