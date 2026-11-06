/**
 * CodeArts 的模型目录与流式对话。
 *
 * 端点与字段形状对齐 2.1.0 的 `vendor/channel-pack/src/llm-adapter.ts`（那是被
 * 真实网关验证过的实现）。三处容易踩的坑，都来自那份实现的实测注释：
 *
 *  1. `assistant` 消息**必须**带 `reasoning_content`（没有就发空串），否则
 *     deepseek-v4 直接 400「Missing reasoning_content field」；
 *  2. 思考开关是**顶层** `thinking`（不是 `extra_body.thinking`），传
 *     `{type:'disabled'}` 才真的关掉，传 `enabled` 与不传等价；
 *  3. `max_tokens` 超 65536 会被后端判成空流（131072 实测被拒），所以默认 65536。
 *
 * 免费额度在这套协议里叫 benefit：模型请求带 `maas_type: benefit` 头，额度用完
 * 回 `InferHub.4004.200`，按 UTC+8 自然日重置。
 */

import { randomBytes, randomUUID } from 'node:crypto'

import { signHuaweiRequest, toFetchHeaders } from './sigv4.js'
import { DsmlExtractor, buildDsmlSystemPrompt, needsDsmlToolMode } from './dsml.js'
import { acquireSlot, registerSession, setCooldown, cooldownOf } from './sessions.js'

const SNAP_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com'
const CHAT_URL = `${SNAP_BASE}/api/v2/chat/completions`
const BUILTIN_MODELS_URL = `${SNAP_BASE}/v1/model/builtin`
const QUEUE_STATUS_URL = `${SNAP_BASE}/api/v1/queue/status`
const GATEWAY_CONFIG_URL = 'https://opengw.developer.huaweicloud.com/api/v1/gateway/config'

const FETCH_TIMEOUT_MS = 15_000
const CATALOG_TTL_MS = 2 * 60 * 60 * 1000

/** 网关不可达时的兜底清单；真实清单以服务端为准。 */
const FALLBACK_MODELS = [
  'GLM-5.2',
  'GLM-5.1',
  'GLM-5',
  'glm-5.3-flash',
  'openpangu-2.0-flash',
  'openpangu-2.0-pro',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4.1-flash',
]

const DEFAULT_CONTEXT_WINDOW = 131_072
const DEFAULT_MAX_TOKENS = 65_536

/**
 * 实测过「不接受 benefit 头」的模型。
 *
 * 华为云这套是**积分制**而不是「某些模型免费」——清单里每个模型都有
 * input/output 价格与消耗倍率，没有免费的标记位。`maas_type: benefit` 声明的
 * 是「这次走免费权益积分」，服务端按账号当前权益决定给不给；不认的模型回
 * `InferHub.4004.200`。所以策略是**先带、被拒就去掉**，并把结论记下来，
 * 免得每次对话都白跑一次往返。
 */
const noBenefitModels = new Set()

/** `model_id` 常见 `deepseek-v4-flash-2024` 这种带日期的别名，去掉日期才是可调用 id。 */
function normalizeModelId(id) {
  if (id.length > 5) {
    const suffix = id.slice(-5)
    if (suffix.startsWith('-') && /^\d{4}$/.test(suffix.slice(1))) return id.slice(0, -5)
  }
  return id
}

function isVisionModel(id) {
  return /-VL-/i.test(id) || /-VL$/i.test(id)
}

async function signedGet(url, credential, extraHeaders, fetcher) {
  const signed = signHuaweiRequest({
    ak: credential.access_key_id,
    sk: credential.secret_access_key,
    securityToken: credential.security_token,
    method: 'GET',
    url,
    body: '',
    extraHeaders,
  })
  const headers = toFetchHeaders(signed)
  if (extraHeaders !== undefined) {
    // extraHeaders 已参与签名，这里只是把非签名字段补回（值相同，无副作用）
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value)
  }
  const response = await fetcher(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.text()
}

function pickArray(text, path) {
  try {
    let value = JSON.parse(text)
    for (const key of path) {
      if (typeof value !== 'object' || value === null) return undefined
      value = value[key]
    }
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** 内存缓存：清单两小时一刷，避免每轮对话都打两个端点。 */
let catalogCache
let catalogFetchedAt = 0

/**
 * 拉取可用模型清单。
 *
 * 两个端点各有各的用处：`gateway/config` 的 `result.models` 里 id 未带日期后缀的
 * 那批就是**免费权益（benefit）模型**；`model/builtin` 补上其余内置模型。任一
 * 端点失败都不致命——清单少几个模型总比整个渠道不可用强。
 *
 * @returns {Promise<{ models: Array<{id: string, name: string, vision: boolean, benefit: boolean}>, benefitIds: string[] }>}
 */
export async function fetchModelCatalog(credential, { fetcher = fetch, force = false } = {}) {
  if (!force && catalogCache !== undefined && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) {
    return catalogCache
  }

  const seen = new Set()
  const models = []

  /** @param {object} item 服务端的一行；缺失字段一律当「未知」而不是「否」 */
  const add = (item, fallbackId) => {
    const rawId = typeof item?.model_id === 'string' && item.model_id !== '' ? item.model_id : fallbackId
    if (typeof rawId !== 'string' || rawId === '') return
    // display_enabled=false 是「不对外展示」（如纯图片理解模型），列出来只会让人点了报错
    if (item?.display_enabled === false) return
    if (item?.enable === false) return
    const id = normalizeModelId(rawId)
    if (seen.has(id)) return
    seen.add(id)
    const rawName = item?.model_name
    const name = typeof rawName === 'string' && rawName !== '' ? normalizeModelId(rawName) : id
    models.push({
      id,
      name,
      vision: item?.supports_images === true || isVisionModel(rawId),
      contextWindow: Number.isFinite(item?.context_window) && item.context_window > 0
        ? item.context_window
        : DEFAULT_CONTEXT_WINDOW,
      maxOutput: Number.isFinite(item?.max_tokens) && item.max_tokens > 0
        ? item.max_tokens
        : DEFAULT_MAX_TOKENS,
      // 错峰折扣提示（如 deepseek-v4.1-flash 每晚 21:00 后 5 折）
      offPeak: typeof item?.time_slots?.off_peak?.notice?.zh_cn === 'string'
        ? item.time_slots.off_peak.notice.zh_cn
        : undefined,
    })
  }

  try {
    const text = await signedGet(GATEWAY_CONFIG_URL, credential, undefined, fetcher)
    for (const item of pickArray(text, ['result', 'models']) ?? []) {
      if (typeof item === 'object' && item !== null) add(item)
    }
  } catch { /* 网关配置拉不到不算致命：这个端点实测对部分账号回 invalid channel */ }

  try {
    const text = await signedGet(BUILTIN_MODELS_URL, credential, {
      'Content-Type': 'application/json',
      'Agent-Type': 'PromptCenter',
      'X-Language': 'zh-cn',
    }, fetcher)
    for (const item of pickArray(text, ['builtinModels']) ?? []) {
      if (typeof item === 'object' && item !== null) add(item)
    }
  } catch { /* 同上 */ }

  if (models.length === 0) {
    // 两个端点都失败：用兜底清单，至少让选择器里有一个能点的模型。
    for (const id of FALLBACK_MODELS) add({ model_id: id, model_name: id })
  }

  catalogCache = { models }
  catalogFetchedAt = Date.now()
  return catalogCache
}

/** 清空清单缓存（用户在设置页点「刷新」时用）。 */
export function invalidateCatalog() {
  catalogCache = undefined
  catalogFetchedAt = 0
}

/**
 * 这次请求要不要带 `maas_type: benefit`。
 *
 * 默认**都带**：清单里没有免费的标记位，服务端才知道你的账号此刻有哪些权益，
 * 由它回 `InferHub.4004.200` 来否决。被否决过的模型记进 `noBenefitModels`，
 * 之后不再带——这样每种模型最多只多花一次往返。
 */
export function shouldTryBenefit(id) {
  return !noBenefitModels.has(id)
}

/** 记住「这个模型不接受 benefit 头」，下次直接不带。 */
export function markNoBenefit(id) {
  noBenefitModels.add(id)
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => typeof block === 'object' && block !== null && block.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('')
}

/**
 * DSH 的消息 → CodeArts 的 wire 消息。
 *
 * 两条硬规则：
 *  - `assistant` 一律带 `reasoning_content`（空串也要带），否则 deepseek-v4 400；
 *  - 工具结果只保留能配上 `tool_call_id` 的，孤儿结果会让整个请求被拒。
 */
export function serializeMessages(messages, system) {
  const wire = []
  if (typeof system === 'string' && system.length > 0) {
    wire.push({ role: 'system', content: system })
  }

  const knownCallIds = new Set()
  let sequence = 0

  for (const message of messages ?? []) {
    const role = message?.role

    if (role === 'tool') {
      const id = String(message.toolCallId ?? message.tool_call_id ?? message.callId ?? '')
      if (id === '' || !knownCallIds.has(id)) continue
      wire.push({ role: 'tool', tool_call_id: id, content: textOfContent(message.content) || '(no output)' })
      continue
    }

    if (role === 'system' || role === 'developer') {
      const text = textOfContent(message.content)
      if (text !== '') wire.push({ role: 'system', content: text })
      continue
    }

    if (role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : []
      const text = textOfContent(blocks)
      const reasoning = blocks
        .filter(block => typeof block === 'object' && block !== null && block.type === 'reasoning')
        .map(block => String(block.text ?? ''))
        .join('')
      const calls = blocks
        .filter(block => typeof block === 'object' && block !== null && block.type === 'tool-call')
        .map(block => {
          sequence += 1
          const id = String(block.id ?? '') || `call_${sequence}`
          knownCallIds.add(id)
          return {
            id,
            type: 'function',
            function: {
              name: String(block.name ?? ''),
              arguments: String(block.arguments ?? '') || '{}',
            },
          }
        })

      const row = { role: 'assistant', content: text, reasoning_content: reasoning }
      if (calls.length > 0) row.tool_calls = calls
      else if (text === '' && reasoning === '') continue
      wire.push(row)
      continue
    }

    // user 与其它角色统一按 user 发
    const text = textOfContent(message?.content)
    if (text !== '') wire.push({ role: 'user', content: text })
  }

  return wire
}

/** 组装请求体。`options` 即 DSH 传来的 stream 选项。 */
export function buildRequestBody(options, sessionId) {
  const messages = serializeMessages(options.messages, options.system)
  let tools = Array.isArray(options.tools) && options.tools.length > 0
    ? options.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
    : undefined

  // ── deepseek-v4：换 DSML 通道 ────────────────────────────────────────
  // 这些模型不认标准 `tools` 字段（发了也只在正文里打 DSML 文本），
  // 所以改成「system 里给工具清单 + 语法规则」，并把 `tools` 去掉。
  // 别试图两个都发：同时带上会让模型走标准通道却又用 DSML 语法，产出半截 JSON。
  if (tools !== undefined && needsDsmlToolMode(options.model)) {
    const prompt = { role: 'system', content: buildDsmlSystemPrompt(tools) }
    const lastSystem = messages.map(row => row.role).lastIndexOf('system')
    if (lastSystem === -1) messages.unshift(prompt)
    else messages.splice(lastSystem + 1, 0, prompt)
    tools = undefined
  }

  return JSON.stringify({
    model: options.model,
    messages,
    stream: true,
    // 让服务端启用前缀缓存；缺了它 usage 里的 cached_tokens 恒为 0
    prompt_cache_key: sessionId,
    include: ['reasoning.encrypted_content'],
    reasoning_summary: 'auto',
    // 只有「关闭」才发这个字段：`enabled` 与不传等价
    ...options.reasoningEffort === 'off' ? { thinking: { type: 'disabled' } } : {},
    // 大文件 write 的工具参数需要分段流式，否则单条 SSE 事件过大被掐断
    tool_stream: true,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...tools === undefined ? {} : { tools },
  })
}

/** 读一段 SSE，带首 token / 分块两种超时。 */
async function readChunk(reader, timeoutMs, signal, phase) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`codearts: ${phase} 超时（${timeoutMs} ms 无数据）`), { code: 'TIMEOUT' }))
    }, timeoutMs)
  })
  const abort = new Promise((_, reject) => {
    if (signal?.aborted === true) {
      reject(Object.assign(new Error('codearts: 请求已取消'), { code: 'ABORTED' }))
      return
    }
    signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('codearts: 请求已取消'), { code: 'ABORTED' }))
    }, { once: true })
  })
  try {
    return await Promise.race([reader.read(), timeout, abort])
  } finally {
    clearTimeout(timer)
  }
}

const QUOTA_CODES = /4291|insufficient[\s_-]*quota/i
/**
 * 限流类错误码。`TM.00001041` 实测有三重含义（额度高峰、请求过密、以及最常见的
 * 「并发会话数已达上限(3个)」），所以不按码猜原因，只把服务端原文带出去。
 */
const QUEUE_CODES = /TM\.00001041|81111|rate.?limit|too many requests|排队|限流|并发/i
const BENEFIT_MISSING_CODE = 'InferHub.4004.200'
/**
 * 账号对该模型**没有开通权限**。实测 `deepseek-v4-pro` 在未开通的账号上回
 * `TM.000010051 您当前无权调用该模型，请联系企业管理员开通`——这类模型通常
 * 也不会出现在 `/v1/model/builtin` 清单里，硬填 id 才会撞上。
 */
const NO_ENTITLEMENT_CODES = /TM\.00001005|无权调用|not authori[sz]ed/i

function errorText(data) {
  const parts = [data.error_code, data.error_msg, data.message, data.error?.code, data.error?.message]
    .filter(value => typeof value === 'string' && value !== '')
  return parts.join(' ') || '未知错误'
}

/**
 * 「并发会话已满」的展示文案。
 *
 * 服务端只说 `TM.00001041 并发会话数已达上限(3个)，请关闭部分会话后重试`，
 * 但这个网关**没有**任何列出/关闭会话的接口（探过 `/api/v1/queue/list`、
 * `/api/v1/chat/sessions` 等，全是 `APIG.0101 接口不存在`）。所以文案必须
 * 告诉用户「能做什么」：要么等，要么在本机把在跑的请求掐掉。
 */
function concurrencyLimitError(reason) {
  return Object.assign(
    new Error(
      `codearts: 账号并发会话已满（服务端上限 3 个${reason === undefined ? '' : `，${reason}`}）。`
      + '本机会自动换账号或稍等重试；也可以在「设置 → 签到 → 会话」里终止正在跑的请求后重发。',
    ),
    { code: 'QUEUE' },
  )
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) { reject(Object.assign(new Error('codearts: 请求已取消'), { code: 'ABORTED' })); return }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('codearts: 请求已取消'), { code: 'ABORTED' }))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * 查询某模型/某任务的排队状态。
 *
 * 端点与请求头取自 2.1.0 的 `queryQueueStatus`：签名**不含**这三个头，
 * 签完再追加（`Agent-Type` 这里必须是 `INFERHUB_AGENT`，与签到用的
 * `PromptCenter` 不同）。返回 `undefined` 表示端点不可用或载荷无法识别——
 * 调用方据此退回「只报原文」，不因为探测失败而改变主流程。
 */
export async function fetchQueueStatus({ credential, model, taskId, fetcher = fetch, signal }) {
  const url = `${QUEUE_STATUS_URL}?model=${encodeURIComponent(model)}&task_id=${encodeURIComponent(taskId)}`
  let headers
  try {
    headers = toFetchHeaders(signHuaweiRequest({
      ak: credential.access_key_id,
      sk: credential.secret_access_key,
      securityToken: credential.security_token,
      method: 'GET',
      url,
      body: '',
    }))
  } catch {
    return undefined
  }
  headers.set('x-snap-traceid', randomUUID())
  headers.set('Agent-Type', 'INFERHUB_AGENT')
  headers.set('X-Language', 'en')

  let response
  try {
    response = await fetcher(url, { method: 'GET', headers, signal })
  } catch {
    return undefined
  }
  if (response.status !== 200) return undefined
  let body
  try { body = JSON.parse(await response.text()) } catch { return undefined }
  const status = body?.status
  if (status !== 'waiting' && status !== 'working' && status !== 'error' && status !== 'queue_full') return undefined
  return {
    status,
    queueLength: Number(body.queue_length ?? 0) || 0,
    queuePosition: Number(body.queue_position ?? -1),
    message: typeof body.message === 'string' ? body.message : '',
  }
}

/**
 * 发一次流式对话，把 OpenAI 兼容 SSE 转成 DSH 的适配器事件。
 *
 * 事件顺序（DSH 要求）：`block-start` 先于任何 delta，`block-end` 在 `finish` 之前。
 * 工具调用的参数是分片到达的，第一次拿到可用函数名时才宣布块，避免出现无名块。
 *
 * ## 并发会话：本机先自己排队
 *
 * 服务端按账号限 3 个并发会话，且**没有任何查询/关闭会话的接口**。所以策略是：
 *
 * 1. `acquireSlot` 在本地把每个账号的在途流压到上限以内，超出的排队等（不直接失败）；
 * 2. 多账号时轮转起手，撞到上限的账号打 45 秒冷却，改用另一个账号；
 * 3. 全都撞墙才按 3s / 9s / 20s 退避重试——服务端释放名额本身就有延迟；
 * 4. 每路流都登记进 `sessions.js`，设置页能看见、能一键终止（终止即断流，名额立刻释放）。
 *
 * 已经吐过正文的流**不会**重试：重试会让用户看到重复内容。
 */
const QUEUE_COOLDOWN_MS = 45_000
const QUEUE_WAIT_PLAN_MS = [3_000, 9_000, 20_000]

/** 退避计划可被环境变量覆盖（离线探针要把它压成 0，否则一个用例要等 32 秒）。 */
function queueWaitPlan() {
  const raw = process.env.DSH_CODEARTS_QUEUE_BACKOFF_MS
  if (typeof raw === 'string' && raw.trim() !== '') {
    const rows = raw.split(',').map(value => Number(value.trim())).filter(value => Number.isFinite(value) && value >= 0)
    if (rows.length > 0) return rows
  }
  return QUEUE_WAIT_PLAN_MS
}

let roundRobin = 0

/** 仅测试用：把轮转起点复位（生产代码不需要这个）。 */
export function resetRoundRobinForTests() {
  roundRobin = 0
}

/** 归一化账号池：单账号调用（探针）与多账号池（真实运行）走同一套逻辑。 */
function poolOf({ credential, accountId, accounts }) {
  const rows = Array.isArray(accounts) && accounts.length > 0
    ? accounts
    : [{ accountId: accountId ?? 'default', credential }]
  return rows.filter(row => typeof row?.credential?.access_key_id === 'string'
    && row.credential.access_key_id !== ''
    && typeof row.credential.secret_access_key === 'string'
    && row.credential.secret_access_key !== '')
}

/** 无冷却的账号优先，其余保持轮转顺序（而不是直接剔除：全冷却时还得用）。 */
function orderPool(pool, start) {
  const rotated = pool.map((_, index) => pool[(start + index) % pool.length])
  return [
    ...rotated.filter(row => cooldownOf(row.accountId) === undefined),
    ...rotated.filter(row => cooldownOf(row.accountId) !== undefined),
  ]
}

function tryParse(text) {
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * HTTP 错误 → 带 code 的错误。
 *
 * 校验顺序有讲究：`TM.00001041` 是 400 而非 429，若先判 429 再判业务码，
 * 「并发已满」会被误报成「限流」，用户拿到的建议就是错的。
 */
function mapHttpError(status, text, model) {
  const parsed = tryParse(text)
  const message = parsed === undefined ? '' : errorText(parsed)
  const detail = (message || text.trim()).slice(0, 300)
  const code = typeof parsed?.error_code === 'string' ? parsed.error_code : ''

  if (status === 401 || status === 403) {
    // 凭据过期：临时 AK/SK 两小时一换，续期在 index.js（要写回凭据库）。
    return Object.assign(
      new Error(`codearts: 凭据被拒（HTTP ${status}）${detail === '' ? '' : `：${detail}`}`),
      { code: 'INVALID_CREDENTIAL', status },
    )
  }
  if (code === BENEFIT_MISSING_CODE || text.includes(BENEFIT_MISSING_CODE)) {
    return Object.assign(new Error(`codearts: 该模型没有免费权益（${detail}）`), { code: 'BENEFIT_NOT_FOUND', status })
  }
  if (NO_ENTITLEMENT_CODES.test(code) || NO_ENTITLEMENT_CODES.test(detail)) {
    return Object.assign(
      new Error(`codearts: 该账号没有「${model}」的调用权限（${detail}）。换清单内的模型即可。`),
      { code: 'NO_ENTITLEMENT', status },
    )
  }
  if (QUOTA_CODES.test(code) || QUOTA_CODES.test(detail)) {
    return Object.assign(
      new Error(`codearts: 免费额度已用尽（${detail}）。按 UTC+8 自然日重置，可先换其它模型。`),
      { code: 'QUOTA_EXCEEDED', status },
    )
  }
  if (status === 429 || QUEUE_CODES.test(code) || QUEUE_CODES.test(detail)) {
    return concurrencyLimitError(detail === '' ? `HTTP ${status}` : `服务端说：${detail}`)
  }
  return Object.assign(
    new Error(`codearts: HTTP ${status}${detail === '' ? '' : `：${detail}`}`),
    { code: 'SERVER', status },
  )
}

export async function* streamChat(options) {
  const { body, model, signal, fetcher = fetch, sessionId, chatId } = options
  const pool = poolOf(options)
  if (pool.length === 0) {
    throw Object.assign(
      new Error('CodeArts 没有可用的 AK/SK：请到「设置 → 签到」添加并登录一个 CodeArts 账号'),
      { code: 'MISSING_CREDENTIAL' },
    )
  }

  const start = roundRobin++ % pool.length
  let lastError
  let lastReason

  const plan = queueWaitPlan()
  for (let round = 0; round <= plan.length; round++) {
    let tried = 0
    for (const row of orderPool(pool, start)) {
      // 首轮跳过冷却中的账号；之后几轮才动用它们（此时通常已经等了几秒）。
      if (round === 0 && cooldownOf(row.accountId) !== undefined) continue
      // 换账号之间留一点间隔：毫秒级连打两个账号容易被上游当成突发流量，
      // 实测会出现「A 满了、B 紧接着也满了」，隔 400ms 就正常。
      if (tried > 0) await delay(400, signal)
      tried += 1
      try {
        yield* runOnAccount(row, { body, model, signal, fetcher, sessionId, chatId })
        return
      } catch (error) {
        if (error?.code === 'QUEUE' && error.partial !== true) {
          // 给这个账号打冷却：下一轮优先换别的账号，别硬撞同一堵墙。
          setCooldown(row.accountId, QUEUE_COOLDOWN_MS, '并发会话已满')
          lastError = error
          lastReason = `账号 ${row.accountId} 名额已满`
          continue
        }
        // 凭据坏了也换账号试：多账号时这能救回一整轮对话。
        if (error?.code === 'INVALID_CREDENTIAL' && pool.length > 1) {
          lastError = error
          lastReason = `账号 ${row.accountId} 凭据被拒`
          continue
        }
        throw error
      }
    }
    if (round === plan.length) break
    await delay(plan[round], signal)
  }

  if (lastError !== undefined && lastReason === undefined) throw lastError
  throw concurrencyLimitError(
    lastReason === undefined ? '已重试仍被拒' : `${lastReason}，已按 3/9/20 秒退避重试`,
  )
}

/** 在一个账号上跑一轮：拿名额 → 登记 → 请求 → 释放。 */
async function* runOnAccount(row, { body, model, signal, fetcher, sessionId, chatId }) {
  const release = await acquireSlot(row.accountId, { signal })
  const controller = new AbortController()
  const forward = () => controller.abort()
  if (signal?.aborted === true) controller.abort()
  else signal?.addEventListener?.('abort', forward, { once: true })

  const session = registerSession({ accountId: row.accountId, model, controller })
  try {
    yield* attemptStream(row.credential, {
      body, model, fetcher, sessionId, chatId, session,
      signal: controller.signal,
    })
  } finally {
    signal?.removeEventListener?.('abort', forward)
    session.done()
    release()
  }
}

/** 单次请求（含 benefit 头的降级重试）。 */
async function* attemptStream(credential, { body, model, signal, fetcher, sessionId, chatId, session }) {
  let benefitHeader = shouldTryBenefit(model)
  let benefitDropped = false

  for (;;) {
    let retry = false
    try {
      const extraHeaders = benefitHeader ? { maas_type: 'benefit' } : undefined
      const signed = signHuaweiRequest({
        ak: credential.access_key_id,
        sk: credential.secret_access_key,
        securityToken: credential.security_token,
        method: 'POST',
        url: CHAT_URL,
        body,
        extraHeaders,
      })
      const headers = toFetchHeaders(signed)
      headers.set('content-type', 'application/json')
      headers.set('Chat-Id', chatId)
      headers.set('Session-Id', sessionId)
      headers.set('lang', 'en')

      session.setPhase('waiting-response')
      const response = await fetcher(CHAT_URL, { method: 'POST', headers, body, signal })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw mapHttpError(response.status, text, model)
      }

      session.setPhase('streaming')
      let emitted = false
      try {
        for await (const event of parseSse(response, { model, signal })) {
          emitted = true
          yield event
        }
      } catch (error) {
        // 把「已经吐过字」标在错误上：外层据此决定还能不能换账号重试。
        if (typeof error === 'object' && error !== null) {
          error.emitted = emitted
          if (emitted) error.partial = true
        }
        throw error
      }
      session.setPhase('done')
      return
    } catch (error) {
      // 已经吐过正文就不重试/换账号了：重试会让用户看到重复内容。
      if (error?.code === 'QUEUE' && error.emitted === true) throw error
      // 该模型不接受 benefit 头：去掉头重来一次（会改用计费额度），
      // 并把这个结论记下来，之后同类请求不再多跑这一趟。
      if (error?.code === 'BENEFIT_NOT_FOUND' && benefitHeader && !benefitDropped) {
        benefitDropped = true
        benefitHeader = false
        markNoBenefit(model)
        retry = true
      } else {
        throw error
      }
    }
    if (!retry) return
  }
}

async function* parseSse(response, { model, signal }) {
  if (!response.body) {
    throw Object.assign(new Error('codearts: 响应无正文'), { code: 'EMPTY_RESPONSE' })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let nextIndex = 0
  let textBlock
  let reasoningBlock
  let finishReason
  let usage
  let sawData = false
  let firstToken = false
  let streamEnded = false

  const toolCalls = new Map() // wireIndex -> { index, id, name, args, announced }
  const toolOrder = []
  const callIds = new Map()

  // deepseek-v4 走 DSML：正文里混着工具调用标记，必须边收边拆。
  // 其余模型是标准 `tool_calls` 通道，不经过提取器（保持既有已验证行为不变）。
  const dsmlMode = needsDsmlToolMode(model)
  const contentExtractor = dsmlMode ? new DsmlExtractor() : undefined
  const reasoningExtractor = dsmlMode ? new DsmlExtractor() : undefined

  function* emitText(text) {
    if (text === '') return
    if (textBlock === undefined) {
      textBlock = { index: nextIndex++, text: '' }
      yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
    }
    textBlock.text += text
    yield { type: 'text-delta', index: textBlock.index, text }
  }

  function* emitReasoning(text) {
    if (text === '') return
    if (reasoningBlock === undefined) {
      reasoningBlock = { index: nextIndex++, text: '' }
      yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
    }
    reasoningBlock.text += text
    yield { type: 'reasoning-delta', index: reasoningBlock.index, text }
  }

  /**
   * 一次 DSML 调用是**整块到达**的（不像标准通道那样分片），所以直接
   * block-start + 完整参数一次发完。id 自己造：服务端不给 call id，
   * 而 DSH 要靠它把 tool 结果配回调用。
   */
  function* emitDsmlCall(call) {
    if (typeof call?.name !== 'string' || call.name === '') return
    const entry = {
      index: nextIndex++,
      id: `dsml-${randomBytes(8).toString('hex')}`,
      name: call.name,
      args: typeof call.arguments === 'string' && call.arguments !== '' ? call.arguments : '{}',
      announced: true,
    }
    toolCalls.set(entry.id, entry)
    toolOrder.push(entry.index)
    yield { type: 'block-start', index: entry.index, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta',
      index: entry.index,
      id: entry.id,
      name: entry.name,
      argumentsDelta: entry.args,
    }
  }

  let completed = false
  try {
    for (;;) {
      let chunk
      try {
        chunk = await readChunk(
          reader,
          firstToken ? 600_000 : 300_000,
          signal,
          firstToken ? 'stream' : 'first-token',
        )
      } catch (error) {
        if (signal?.aborted === true) throw error
        if (error?.code === 'TIMEOUT' || error?.code === 'ABORTED') throw error
        throw Object.assign(new Error(`codearts: 传输中断：${error?.message ?? error}`), { code: 'TRANSPORT', cause: error })
      }

      if (chunk.done) break
      firstToken = true
      buffer += decoder.decode(chunk.value, { stream: true })

      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data:')) continue
        const raw = line.slice(5).trim()
        if (raw === '[DONE]') { finishReason ??= 'stop'; streamEnded = true; break }
        if (raw === '') continue

        let data
        try { data = JSON.parse(raw) } catch { continue }
        sawData = true

        if (typeof data.error_code === 'string' && data.error_code !== '') {
          const message = errorText(data)
          if (QUOTA_CODES.test(data.error_code) || QUOTA_CODES.test(message)) {
            throw Object.assign(new Error(`codearts: 免费额度已用尽（${message}）。按 UTC+8 自然日重置，可先换其它模型。`), { code: 'QUOTA_EXCEEDED' })
          }
          if (data.error_code === BENEFIT_MISSING_CODE) {
            throw Object.assign(new Error(`codearts: 该模型没有免费权益（${message}）`), { code: 'BENEFIT_NOT_FOUND' })
          }
          if (QUEUE_CODES.test(data.error_code) || QUEUE_CODES.test(message)) {
            // 服务端有时用 HTTP 200 + 内嵌错误事件表达排队/占满，与 400 同义。
            throw concurrencyLimitError(`服务端说：${message}`)
          }
          if (NO_ENTITLEMENT_CODES.test(data.error_code) || NO_ENTITLEMENT_CODES.test(message)) {
            throw Object.assign(
              new Error(`codearts: 该账号没有「${model}」的调用权限（${message}）。它通常也不在模型清单里，换清单内的模型即可。`),
              { code: 'NO_ENTITLEMENT' },
            )
          }
          throw Object.assign(new Error(`codearts: ${message}`), { code: 'INVALID_REQUEST' })
        }

        const choice = data.choices?.[0]
        const delta = choice?.delta
        if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') {
          finishReason = choice.finish_reason
        }

        if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content !== '') {
          if (dsmlMode) {
            // 实测 deepseek-v4 有时把 DSML 块写进 reasoning_content 而不是正文，
            // 所以这里也过一遍提取器；拆出来的正文同样按思考展示。
            const out = reasoningExtractor.feed(delta.reasoning_content)
            yield* emitReasoning(out.text + out.reasoning)
            for (const call of out.toolCalls) yield* emitDsmlCall(call)
          } else {
            yield* emitReasoning(delta.reasoning_content)
          }
        }

        if (typeof delta?.content === 'string' && delta.content !== '') {
          if (dsmlMode) {
            const out = contentExtractor.feed(delta.content)
            yield* emitText(out.text)
            yield* emitReasoning(out.reasoning)
            for (const call of out.toolCalls) yield* emitDsmlCall(call)
          } else {
            yield* emitText(delta.content)
          }
        }

        for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
          const wireIndex = call.index ?? 0
          if (typeof call.id === 'string' && call.id !== '') callIds.set(wireIndex, call.id)
          const id = callIds.get(wireIndex) ?? `call_${wireIndex}`
          let entry = toolCalls.get(wireIndex)
          if (entry === undefined) {
            entry = { index: nextIndex++, id, name: '', args: '', announced: false }
            toolCalls.set(wireIndex, entry)
          }
          entry.id = id
          if (typeof call.function?.name === 'string' && call.function.name !== '') {
            entry.name = call.function.name
          }
          const fragment = String(call.function?.arguments ?? '')
          entry.args += fragment

          if (!entry.announced) {
            if (entry.name === '') continue
            entry.announced = true
            toolOrder.push(entry.index)
            yield { type: 'block-start', index: entry.index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index: entry.index, id: entry.id, name: entry.name, argumentsDelta: entry.args }
            continue
          }
          yield {
            type: 'tool-call-delta',
            index: entry.index,
            id: entry.id,
            name: entry.name,
            argumentsDelta: fragment,
          }
        }

        if (data.usage !== undefined && data.usage !== null) {
          const promptTokens = Number(data.usage.prompt_tokens) || 0
          const cached = Number(data.usage.prompt_tokens_details?.cached_tokens
            ?? data.usage.prompt_cache_hit_tokens) || 0
          const reasoning = Number(data.usage.completion_tokens_details?.reasoning_tokens) || 0
          usage = {
            inputTokens: Math.max(0, promptTokens - cached),
            outputTokens: Number(data.usage.completion_tokens) || 0,
            ...cached > 0 ? { cacheReadTokens: cached } : {},
            ...reasoning > 0 ? { reasoningTokens: reasoning } : {},
          }
        }
      }

      // 服务端发了 [DONE]：主动断开，不再 read()。
      // 继续读会一直等到对端关闭连接，这期间服务端仍把这个会话算作「进行中」，
      // 占着并发名额（每模型上限 3 个，实测回 TM.00001041）。主动 cancel 能让
      // 名额尽快释放，否则连测几次就把账号的并发额度占满。
      if (streamEnded) {
        await reader.cancel().catch(() => {})
        break
      }
    }
    completed = true
  } finally {
    // ⚠️ 异常路径必须主动 cancel：只 releaseLock 不会断开连接，服务端会一直把
    // 这一路算成「会话进行中」，把账号的 3 个并发名额占满（随后所有请求都回
    // TM.00001041）。这是「越用越卡、只能重启」的真正原因。
    if (!completed) await reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* 已 cancel 时可能已释放 */ }
  }

  if (!sawData) {
    throw Object.assign(new Error('codearts: 响应里没有任何数据帧'), { code: 'EMPTY_RESPONSE' })
  }

  // DSML 提取器为了躲开「标记被切在两个 chunk 之间」会扣住一小段尾巴，
  // 流结束时必须吐出来，否则最后几个字（或末尾一次工具调用）会丢。
  if (dsmlMode) {
    for (const extractor of [contentExtractor, reasoningExtractor]) {
      const out = extractor.flush()
      yield* emitText(out.text)
      yield* emitReasoning(out.reasoning)
      for (const call of out.toolCalls) yield* emitDsmlCall(call)
    }
  }

  // ── 收尾：先补齐 block-end，再发 finish ──────────────────────────────
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
      block: {
        type: 'tool-call',
        id: entry.id,
        name: entry.name,
        arguments: entry.args === '' ? '{}' : entry.args,
      },
    })
  }
  blocks.sort((a, b) => a.index - b.index)
  for (const row of blocks) yield { type: 'block-end', index: row.index, block: row.block }

  if (usage !== undefined) yield { type: 'usage', usage }

  const kind = finishReason === 'length'
    ? 'max-tokens'
    : toolOrder.length > 0 || finishReason === 'tool_calls'
      ? 'tool-calls'
      : 'stop'
  yield { type: 'finish', reason: { kind } }
}

/** 供适配器组装 `resolveModel` 用。上下文窗口与输出上限都取服务端下发的值。 */
export function modelInfo(id) {
  const cached = catalogCache?.models.find(row => row.id === id)
  return {
    id,
    name: cached?.name ?? id,
    contextWindow: cached?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutput: cached?.maxOutput ?? DEFAULT_MAX_TOKENS,
    vision: cached?.vision === true,
    offPeak: cached?.offPeak,
  }
}

export { FALLBACK_MODELS, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS }
