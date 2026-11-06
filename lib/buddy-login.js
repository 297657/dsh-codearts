/**
 * CodeBuddy / WorkBuddy 的浏览器登录流程（移植自 dsh-our-free-model 2.1.0 的
 * `vendor/channel-pack/pack.js`，`credits.ts` / `buddy-auth.ts` 那部分）。
 *
 * 为什么要自己搬一遍：2.8.0 把腾讯系渠道整体移除了，账号管理页随之消失，
 * 但账号池里的数据还在。要让「新增账号」重新可用，只能把这两条登录链路带回来。
 *
 * 流程是三段（与 2.1.0 完全一致，没有简化）：
 *   1. `POST /v2/plugin/auth/state?platform=` 取 state + authUrl；
 *   2. 用户在浏览器里授权，我们 `GET /v2/plugin/auth/token?state=` 轮询换 token；
 *   3. `GET /v2/plugin/login/account?state=` 取账号资料，拼成凭据 JSON。
 *
 * 三段都用产品身份头（X-Domain / UA），否则 WorkBuddy 会以 CodeBuddy 的身份发请求。
 */

const AUTH_STATE_PATH = '/v2/plugin/auth/state'
const AUTH_TOKEN_PATH = '/v2/plugin/auth/token'
const LOGIN_ACCOUNT_PATH = '/v2/plugin/login/account'

const STATE_REQUEST_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 60_000
const LOGIN_TIMEOUT_MS = 5 * 60_000
const POLL_INTERVAL_MS = 1_000

const CODE_TOKEN_NOT_READY = 11217
const CODE_ACCOUNT_NOT_READY = 12151

const HEADER_DOMAIN = 'X-Domain'
const HEADER_NO_AUTHORIZATION = 'X-No-Authorization'
const HEADER_NO_USER_ID = 'X-No-User-Id'
const HEADER_NO_ENTERPRISE_ID = 'X-No-Enterprise-Id'
const HEADER_NO_DEPARTMENT_INFO = 'X-No-Department-Info'

/** 与 2.1.0 的 CODEBUDDY / WORKBUDDY 产品定义保持逐字段一致。 */
export const PRODUCTS = {
  buddy: {
    id: 'buddy',
    platform: 'ide',
    endpoint: 'https://copilot.tencent.com',
    apiDomain: 'copilot.tencent.com',
    userAgent: 'CodeBuddyIDE/1.106.1',
  },
  workbuddy: {
    id: 'workbuddy',
    platform: 'workbuddy-ai',
    endpoint: 'https://www.workbuddy.ai',
    apiDomain: 'www.workbuddy.ai',
    userAgent: 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2',
  },
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function stripControlChars(value) {
  return value
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function readStringField(data, key) {
  const value = data[key]
  if (typeof value === 'string') return stripControlChars(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function readNumberField(data, key) {
  const value = data[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

/** 解析 JWT payload；token 不是三段式或解不开时返回空对象。 */
function jwtPayload(token) {
  if (typeof token !== 'string' || token.length === 0) return {}
  const parts = token.split('.')
  if (parts.length < 2) return {}
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function jwtIssuedAtMs(token) {
  const iat = jwtPayload(token).iat
  return typeof iat === 'number' && Number.isFinite(iat) ? iat * 1000 : undefined
}

function absoluteExpiryMs(record, absoluteKey, relativeKey, accessToken) {
  const absolute = readStringField(record, absoluteKey)
  if (absolute.length > 0) {
    const asNumber = /^\d+$/.test(absolute) ? Number(absolute) : Date.parse(absolute)
    if (Number.isFinite(asNumber)) return String(asNumber > 1e12 ? asNumber : asNumber * 1000)
    return absolute
  }
  const relativeSeconds = readNumberField(record, relativeKey)
  if (relativeSeconds === undefined) return ''
  const baseMs = jwtIssuedAtMs(accessToken) ?? Date.now()
  return String(baseMs + relativeSeconds * 1000)
}

function parseTokenData(data) {
  const record = typeof data === 'object' && data !== null ? data : {}
  const tokenType = readStringField(record, 'tokenType')
  const accessToken = readStringField(record, 'accessToken')
  return {
    accessToken,
    refreshToken: readStringField(record, 'refreshToken'),
    expiresAt: absoluteExpiryMs(record, 'expiresAt', 'expiresIn', accessToken),
    refreshExpiresAt: absoluteExpiryMs(record, 'refreshExpiresAt', 'refreshExpiresIn', accessToken),
    tokenType: tokenType.length > 0 ? tokenType : 'Bearer',
    scope: readStringField(record, 'scope'),
    domain: readStringField(record, 'domain'),
  }
}

function parseAccountData(data) {
  const record = typeof data === 'object' && data !== null ? data : {}
  const accountType = readStringField(record, 'type')
  return {
    uid: readStringField(record, 'uid'),
    nickname: readStringField(record, 'nickname'),
    enterpriseId: readStringField(record, 'enterpriseId'),
    accountType: accountType.length > 0 ? accountType : 'personal',
  }
}

function buildCredential(token, account) {
  const nickname = account.nickname.length > 0 ? account.nickname : jwtNickname(token.accessToken)
  const subject = jwtPayload(token.accessToken).sub
  return {
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expires_at: token.expiresAt,
    refresh_expires_at: token.refreshExpiresAt,
    token_type: token.tokenType,
    scope: token.scope,
    domain: token.domain,
    user_id: account.uid.length > 0 ? account.uid : (typeof subject === 'string' ? subject : ''),
    nickname,
    enterprise_id: account.enterpriseId,
    account_type: account.accountType,
  }
}

function jwtNickname(token) {
  const payload = jwtPayload(token)
  const nickname = payload.nickname ?? payload.preferred_username ?? payload.name
  return typeof nickname === 'string' ? stripControlChars(nickname) : ''
}

export function credentialExpiresAtMs(credential) {
  const raw = credential?.expires_at
  if (typeof raw === 'string' && raw.length > 0) {
    if (/^\d+$/.test(raw)) {
      const value = Number(raw)
      return value > 1e12 ? value : value * 1000
    }
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  const exp = jwtPayload(credential?.access_token).exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
}

function responseCode(body) {
  const code = typeof body === 'object' && body !== null ? body.code : 0
  return typeof code === 'number' ? code : 0
}

function responseMessage(body) {
  const message = typeof body === 'object' && body !== null ? body.message : ''
  return typeof message === 'string' ? message : ''
}

function responseData(body) {
  if (typeof body !== 'object' || body === null) return undefined
  return body.data === null ? undefined : body.data
}

async function request(method, url, headers, timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal])
  let response
  try {
    response = await fetch(url, { method, headers, signal: combined })
  } catch (error) {
    throw new Error(`登录请求失败（${method} ${url}）：${error?.message ?? error}`)
  }
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

/** 第一步：取 state 与授权地址。 */
export async function startBuddyLogin(channelId) {
  const product = PRODUCTS[channelId]
  if (product === undefined) throw new Error(`不支持登录渠道 ${channelId}`)

  const url = `${product.endpoint}${AUTH_STATE_PATH}?platform=${product.platform}`
  const headers = {
    [HEADER_DOMAIN]: product.apiDomain,
    [HEADER_NO_AUTHORIZATION]: 'true',
    [HEADER_NO_USER_ID]: 'true',
    [HEADER_NO_ENTERPRISE_ID]: 'true',
    [HEADER_NO_DEPARTMENT_INFO]: 'true',
    'User-Agent': product.userAgent,
  }
  const { status, body } = await request('POST', url, headers, STATE_REQUEST_TIMEOUT_MS)
  if (status !== 200) throw new Error(`auth/state HTTP ${status}：${responseMessage(body)}`)

  const data = responseData(body)
  if (typeof data !== 'object' || data === null) throw new Error('auth/state 响应缺少 data 字段')
  const state = typeof data.state === 'string' ? data.state : ''
  const authUrl = typeof data.authUrl === 'string' ? data.authUrl : ''
  if (state.length === 0) throw new Error('auth/state 响应缺少 state 字段')
  if (authUrl.length === 0) throw new Error('auth/state 响应缺少 authUrl 字段')

  return { state, loginUrl: authUrl }
}

async function loopGetToken(state, product, options) {
  const url = `${product.endpoint}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`
  const headers = {
    [HEADER_NO_AUTHORIZATION]: 'true',
    'User-Agent': product.userAgent,
  }
  const deadline = Date.now() + (options.timeoutMs ?? LOGIN_TIMEOUT_MS)
  for (;;) {
    if (Date.now() >= deadline) throw new Error('等待授权超时（5 分钟）')
    if (options.signal?.aborted) throw new Error('登录已取消')
    await sleep(options.pollIntervalMs ?? POLL_INTERVAL_MS)

    let result
    try {
      result = await request('GET', url, headers, REQUEST_TIMEOUT_MS, options.signal)
    } catch {
      continue
    }
    const { status, body } = result
    if (status === 200) {
      const data = responseData(body)
      if (data !== undefined) return parseTokenData(data)
      continue
    }
    if (responseCode(body) === CODE_TOKEN_NOT_READY) continue
    throw new Error(`auth/token HTTP ${status}：${responseMessage(body)}`)
  }
}

async function loopGetAccount(state, token, product, options) {
  const url = `${product.endpoint}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`
  const headers = {
    // token.domain 是服务端本次下发的权威值，非空时优先于产品默认域名。
    [HEADER_DOMAIN]: token.domain || product.apiDomain,
    Authorization: `Bearer ${token.accessToken}`,
    [HEADER_NO_USER_ID]: 'true',
    [HEADER_NO_ENTERPRISE_ID]: 'true',
    'User-Agent': product.userAgent,
  }
  const deadline = Date.now() + (options.timeoutMs ?? LOGIN_TIMEOUT_MS)
  for (;;) {
    if (Date.now() >= deadline) throw new Error('获取账号信息超时（5 分钟）')
    if (options.signal?.aborted) throw new Error('登录已取消')
    await sleep(options.pollIntervalMs ?? POLL_INTERVAL_MS)

    let result
    try {
      result = await request('GET', url, headers, REQUEST_TIMEOUT_MS, options.signal)
    } catch {
      continue
    }
    const { status, body } = result
    if (status === 200) {
      const data = responseData(body)
      if (data !== undefined) return parseAccountData(data)
      continue
    }
    if (responseCode(body) === CODE_ACCOUNT_NOT_READY) continue
    throw new Error(`login/account HTTP ${status}：${responseMessage(body)}`)
  }
}

/** 第二、三步：等用户授权完成，换 token 并取账号资料。 */
export async function finishBuddyLogin(state, channelId, options = {}) {
  const product = PRODUCTS[channelId]
  if (product === undefined) throw new Error(`不支持登录渠道 ${channelId}`)

  const token = await loopGetToken(state, product, options)
  const account = await loopGetAccount(state, token, product, options)
  const credential = buildCredential(token, account)
  return {
    credential,
    serialized: JSON.stringify(credential),
    nickname: credential.nickname,
    expiresAt: credentialExpiresAtMs(credential),
    refreshable: credential.refresh_token.length > 0,
  }
}
