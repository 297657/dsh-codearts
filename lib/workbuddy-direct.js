/**
 * WorkBuddy 模型渠道的「直连」传输（手机 DSH Go 用，不依赖 Windows 桌面端）。
 *
 * ## 为什么会有这个文件
 *
 * 原实现 `workbuddy-llm.js` 只走 wbipc 命名管道 + 桌面端 `wb.request/http.fetch`。
 * 手机上没有 WorkBuddy 桌面端、没有命名管道，那条路彻底不可用。逆向 WorkBuddy
 * 客户端（app.asar）后确认：`/v2/chat/completions` 的「渠道校验（11128 request
 * illegal）」校验的是**一组可在任意 Node 环境复现的静态网关头 + 随机 UUID**，
 * 而不是绑定 Windows 的设备硬件标识。凭据里的 access_token / user_id /
 * enterprise_id / domain 足以构造出全部身份头。因此手机上可以直接用 fetch
 * 调通，不需要桌面端代理。
 *
 * 证据（WorkBuddy 客户端 app.asar，混淆后片段）：
 * - `applyGatewayHeaders`：x-requested-with / X-Agent-Intent=craft /
 *   X-Agent-Purpose=conversation / x-codebuddy-request=1 / X-IDE-Type/Name /
 *   X-IDE-Version / X-Private-Data / X-Conversation-* / X-Request-ID / traceparent …
 * - `buildVlmGatewayHeaders`：X-User-Id / X-Enterprise-Id / X-Tenant-Id /
 *   X-Domain / X-Product / User-Agent …
 * - `resolveBackendAuthFromHost`（wbipc 注入头）：authorization: Bearer <token> +
 *   x-user-id + x-enterprise-id + x-tenant-id。
 *
 * 实测（2026-11-16）：补齐这些头后，对话接口的 11128「request illegal」消失，
 * 说明通道校验通过；继续报的错是请求格式（首条须为 system）与账号风控，均与
 * 平台无关——手机和桌面直连会遇到同样的服务端策略，可用性和官方客户端一致。
 *
 * ## 设计
 *
 * 与 `WbipcClient` 暴露相同的接口（connect / recover / chat / getModels /
 * getAccount / isConnected / disconnect），让 `WorkBuddyAdapter` 与 runtime 无需
 * 区分传输方式。唯一的额外构造参数是 `resolveCredential`：一个 async 函数，
 * 返回当前要用的 WorkBuddy 凭据对象（走宿主 ctx.credentials，跨平台）。
 *
 * ⚠️ 凭据只用于构造请求头，绝不写日志、绝不回传给浏览器。
 */

import { randomUUID, randomBytes } from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 30_000
const CHAT_TIMEOUT_MS = 300_000

function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 一组随机 trace 头，等价复刻 WorkBuddy 的 applyTraceHeaders。 */
function traceHeaders() {
  const t = randomBytes(16).toString('hex')
  const span = randomBytes(8).toString('hex')
  const parent = randomBytes(8).toString('hex')
  return {
    traceparent: `00-${t}-${span}-01`,
    b3: `${t}-${span}-1-${parent}`,
    'X-B3-TraceId': t,
    'X-B3-ParentSpanId': parent,
    'X-B3-SpanId': span,
    'X-B3-Sampled': '1',
    'X-Trace-ID': t,
  }
}

/**
 * 构造 WorkBuddy 网关请求头。
 *
 * 三组来源合并：
 *  1. 凭据身份头（Bearer / user / enterprise / domain）——来自凭据本身；
 *  2. 产品头（X-IDE-* / X-Product / UA）——静态值，随客户端版本；
 *  3. 会话头（X-Conversation-* / X-Request-ID / x-codebuddy-request=1 等）——
 *     每次请求现生成，正是这组让「渠道校验」放行。
 */
export function gatewayHeaders(credential, { endpoint } = {}) {
  const domain = str(credential.domain) || (endpoint ? new URL(endpoint).host : 'www.workbuddy.ai')
  const version = str(credential.clientVersion) || '5.5.2'
  const headers = {
    Authorization: `Bearer ${str(credential.access_token)}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'X-Request-ID': randomUUID(),
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
    'acp-connection-id': randomUUID(),
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'x-codebuddy-request': '1',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': version,
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
    'X-Domain': domain,
    'User-Agent': `WorkBuddy/${version} WorkBuddy/${version} CLI/${version}`,
    ...traceHeaders(),
  }
  const userId = str(credential.user_id)
  if (userId !== '') headers['X-User-Id'] = userId
  const enterpriseId = str(credential.enterprise_id)
  if (enterpriseId !== '') {
    headers['X-Enterprise-Id'] = enterpriseId
    headers['X-Tenant-Id'] = enterpriseId
  }
  return headers
}

/** fetch 响应 → 与 WbipcClient.httpFetch 相同的形状。 */
async function toResult(response, timeoutMs) {
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON（如 SSE / HTML）保留原文 */ }
  const headers = {}
  response.headers.forEach((value, key) => {
    // 只保留白名单头，与 wbipc 的 jz 集合一致
    if (['content-type', 'content-length', 'etag', 'last-modified', 'retry-after', 'location', 'x-request-id'].includes(key.toLowerCase())) {
      headers[key.toLowerCase()] = value
    }
  })
  return { status: response.status, headers, body: text, json }
}

export class DirectClient {
  /**
   * @param {object} options
   * @param {() => Promise<object|undefined>} options.resolveCredential 取当前凭据
   * @param {string} [options.endpoint] 固定网关域名；不传则跟随凭据 domain
   * @param {object} [options.logger]
   */
  constructor({ resolveCredential, endpoint, logger = console } = {}) {
    this.resolveCredential = resolveCredential
    this.endpoint = endpoint
    this.logger = logger
    this.connected = false
  }

  async connect() {
    // 直连没有握手：能取到凭据即视为就绪
    const credential = await this.resolveCredential()
    if (!credential || str(credential.access_token) === '') {
      throw Object.assign(new Error('WorkBuddy 未登录：请先在本设备添加 WorkBuddy 账号'), { code: 'MISSING_CREDENTIAL' })
    }
    this.connected = true
    return true
  }

  async recover() {
    this.connected = false
    return this.connect()
  }

  isConnected() { return this.connected }

  disconnect() { this.connected = false }

  get baseUrl() {
    return this.endpoint ?? 'https://www.workbuddy.ai'
  }

  async httpFetch(method, path, { headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const credential = await this.resolveCredential()
    if (!credential || str(credential.access_token) === '') {
      throw Object.assign(new Error('WorkBuddy 未登录：请先在本设备添加 WorkBuddy 账号'), { code: 'MISSING_CREDENTIAL' })
    }
    const domain = str(credential.domain) || (this.endpoint ? new URL(this.endpoint).host : 'www.workbuddy.ai')
    const base = this.endpoint ?? `https://${domain}`
    const url = `${base.replace(/\/+$/, '')}${path}`
    const allHeaders = { ...gatewayHeaders(credential, { endpoint: base }), ...headers }
    // 流式接口要 text/event-stream，网关头默认是 application/json
    if (String(headers.accept ?? '').includes('text/event-stream')) allHeaders.Accept = 'text/event-stream'
    const response = await fetch(url, {
      method,
      headers: allHeaders,
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    })
    this.connected = true
    return toResult(response, timeoutMs)
  }

  async getAccount() {
    const r = await this.httpFetch('GET', '/v2/plugin/login/account')
    return r.json?.data ?? null
  }

  async getModels() {
    const r = await this.httpFetch('GET', '/v2/enterprises/personal/models')
    const models = r.json?.data?.models
    if (!Array.isArray(models) || models.length === 0) return []
    return models.map(m => ({
      id: str(m.id),
      name: str(m.name) || str(m.id),
      contextWindow: Number(m.maxInputTokens) > 0 ? Number(m.maxInputTokens) : 131_072,
      maxOutput: Number(m.maxOutputTokens) > 0 ? Number(m.maxOutputTokens) : 32_768,
      vision: m.supportsImages === true,
      supportsReasoning: m.supportsReasoning === true,
      supportsToolCall: m.supportsToolCall !== false,
    })).filter(m => m.id !== '')
  }

  async chat(body) {
    return this.httpFetch('POST', '/v2/chat/completions', {
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: { ...body, stream: true },
      timeoutMs: CHAT_TIMEOUT_MS,
    })
  }
}
