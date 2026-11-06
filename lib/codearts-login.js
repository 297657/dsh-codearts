/**
 * 华为云 CodeArts 的浏览器登录与续期（OAuth 2.0 授权码 + PKCE + DPoP）。
 *
 * 移植自 dsh-our-free-model 2.1.0 的 `vendor/channel-pack/src/{oauth,login}.ts`。
 * 与原实现的差别只有一个：原实现依赖 `jose` 库做 ES256，本插件不引依赖，
 * 改用 `node:crypto` 直接构造 DPoP JWS（见 `dpopProof`）。
 *
 * ## 为什么必须连续期一起搬
 *
 * CodeArts 走 STS 换的是**临时 AK/SK/SecurityToken**，实测寿命约 2 小时
 * （凭据里的 `expires_at`）。2.8.0 把 codearts 整体移出账号池管理后，
 * 没有任何组件再给它续期——只补登录不补续期的话，用户点完「添加」，
 * 当天晚些时候签到就会开始报「临时凭据已过期」。
 *
 * 续期材料是登录时一并返回的三件套，都存在凭据里：
 * `refresh_token` / `code_verifier` / `dpop_private_key_jwk`。
 * 三者齐才可续期（对应 2.1.0 的 `isCodeArtsRefreshable`）。
 *
 * ## 流程
 *
 *   1. 生成 PKCE（verifier/challenge）与 ES256 密钥对；
 *   2. 本地起回调服务器（端口 >= 10000，见 `listenOnCallbackPort`）；
 *   3. 拼授权 URL 交给用户浏览器打开；
 *   4. 浏览器回跳 `http://127.0.0.1:<port>/oauth/callback?code=...`；
 *   5. 用 code + verifier 向 STS 换 token，请求头带 DPoP 证明；
 *   6. 把 `credentials.*` 与续期三件套拼成凭据 JSON。
 *
 * ## 坑
 *
 * 1. **`code_challenge_method` 是 `SHA-256` 而不是 `S256`**。portal 只认前者，
 *    写成标准值会被判 `invalid_request`。
 * 2. **ES256 的 JWS 签名必须是 64 字节 raw R||S**，不是 DER。Node 的
 *    `crypto.sign()` 默认输出 DER，必须显式指定 `dsaEncoding: 'ieee-p1363'`。
 *    这条弄错时服务端只会回一个含糊的 `invalid_dpop_proof`。
 * 3. **回调端口必须 >= 10000**。portal 会把 `port` 原样用于回跳，
 *    低端口在部分系统上需要特权，实测被 portal 拒绝。
 * 4. `htu` 必须是完整 URL 且**不含 query**，与实际请求目标逐字符一致。
 */

import { createServer } from 'node:http'
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as signPayload,
} from 'node:crypto'

const CLIENT_ID = 'codearts-agent'
const REDIRECT_PATH = '/oauth/callback'
const STS_TOKEN_ENDPOINT = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens'
const PORTAL_AUTHORIZE_BASE = 'https://codearts.huaweicloud.com/portal/authorize'
const PORTAL_LOGIN_BASE = 'https://codearts.huaweicloud.com/portal/login'
const CREDENTIAL_ENDPOINT =
  'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket'

const LOGIN_PLUGIN_NAME = 'snap_AIIDE'
const LOGIN_PLUGIN_VERSION = '5.2.0'
const TICKET_PLUGIN_NAME = 'snap_jetbrains'
const TICKET_PLUGIN_VERSION = '26.3.3'

const OAUTH_THEME = '2'
const OAUTH_LOCALE = 'zh-cn'
const OAUTH_CALLBACK_TIMEOUT_MS = 180_000
const MIN_CALLBACK_PORT = 10_000
const TOKEN_TIMEOUT_MS = 60_000
const TICKET_POLL_MAX_ATTEMPTS = 120

const GRANT_AUTHORIZATION_CODE = 'authorization_code'
const GRANT_REFRESH_TOKEN = 'refresh_token'

/** 距过期不足这么久就主动续期，避免「查得到状态、领的时候刚好过期」。 */
export const REFRESH_LEAD_MS = 15 * 60_000

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function generatePkcePair() {
  const codeVerifier = randomBytes(48).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

/**
 * 生成 ES256（P-256）密钥对，返回 JWK 形态。
 *
 * 必须 `extractable` 等价：私钥要能导出成 JWK 存进凭据，续期时再还原。
 */
function generateDpopKeyPair() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const privateKeyJwk = privateKey.export({ format: 'jwk' })
  return { privateKeyJwk, publicKeyJwk: publicJwkOf(privateKeyJwk) }
}

/** 公钥 JWK 只保留四个必备字段——DPoP header 里带 `d` 会直接被拒。 */
function publicJwkOf(privateKeyJwk) {
  return {
    kty: privateKeyJwk.kty,
    crv: privateKeyJwk.crv,
    x: privateKeyJwk.x,
    y: privateKeyJwk.y,
  }
}

/**
 * 构造 DPoP 证明（`typ: dpop+jwt`）。
 *
 * 签名是 raw R||S（`ieee-p1363`），不是 DER —— 见文件头第 2 条。
 */
function dpopProof(privateKeyJwk, htm, htu) {
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwkOf(privateKeyJwk) }
  const payload = {
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(32).toString('hex'),
  }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const key = createPrivateKey({ key: privateKeyJwk, format: 'jwk' })
  const signature = signPayload('sha256', Buffer.from(signingInput, 'utf8'), {
    key,
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${base64url(signature)}`
}

class RefreshTokenExpiredError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

async function requestToken(body, privateKeyJwk, fetcher = fetch) {
  const dpop = dpopProof(privateKeyJwk, 'POST', STS_TOKEN_ENDPOINT)
  let response
  try {
    response = await fetcher(STS_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { DPoP: dpop, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`CodeArts 令牌请求网络错误：${error?.message ?? String(error)}`)
  }

  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok || !data?.credentials) {
    const detail = data === null ? '' : ` ${JSON.stringify(data)}`
    const errorCode = String(data?.error_code ?? '')
    if (data?.error === 'invalid_grant' || errorCode.includes('ExpiredRefreshToken')) {
      throw new RefreshTokenExpiredError(`CodeArts 令牌请求失败：${response.status}${detail}`)
    }
    throw new Error(`CodeArts 令牌请求失败：${response.status}${detail}`)
  }
  return data
}

function exchangeAuthorizationCode(code, codeVerifier, port, privateKeyJwk, fetcher = fetch) {
  return requestToken(
    {
      client_id: CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      grant_type: GRANT_AUTHORIZATION_CODE,
      redirect_uri: `http://127.0.0.1:${port}${REDIRECT_PATH}`,
    },
    privateKeyJwk,
    fetcher,
  )
}

function exchangeRefreshToken(refreshToken, codeVerifier, privateKeyJwk, fetcher = fetch) {
  return requestToken(
    {
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
      grant_type: GRANT_REFRESH_TOKEN,
      refresh_token: refreshToken,
    },
    privateKeyJwk,
    fetcher,
  )
}

/** 华为云返回的 `expiration` 可能是 ISO 字符串或毫秒数，统一成 ISO。 */
function normalizeExpiration(raw) {
  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = Date.parse(raw)
    return Number.isNaN(parsed) ? raw : new Date(parsed).toISOString()
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000
    return new Date(ms).toISOString()
  }
  return ''
}

/**
 * 从 STS 响应拼出凭据。
 *
 * 字段名与 2.1.0 的 `credentialFromTokenResponse` 逐字对齐——签到侧的
 * `signedRequest` 读的就是 `access_key_id` / `secret_access_key` / `security_token`。
 */
function credentialFromTokenResponse(token, codeVerifier, privateKeyJwk) {
  const credentials = token.credentials ?? {}
  return {
    access_key_id: credentials.access_key_id ?? '',
    secret_access_key: credentials.secret_access_key ?? '',
    security_token: credentials.security_token ?? '',
    expires_at: normalizeExpiration(credentials.expiration),
    refresh_token: token.refresh_token ?? '',
    code_verifier: codeVerifier,
    dpop_private_key_jwk: privateKeyJwk,
  }
}

/** 续期材料三件套齐备才可续期（与 2.1.0 的 `isCodeArtsRefreshable` 同判据）。 */
export function isRefreshable(credential) {
  return Boolean(
    credential?.refresh_token && credential?.code_verifier && credential?.dpop_private_key_jwk,
  )
}

export function expiresAtMs(credential) {
  const raw = credential?.expires_at
  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

/**
 * 用 refresh_token 换一份新凭据（**不落盘**，由调用方决定是否写回）。
 *
 * ⚠️ STS 续期响应**可能不带 `refresh_token`**（实测有的租户带、有的不带）。
 * 直接覆盖会把续期材料弄丢，这个账号从此再也刷不动——必须沿用旧值。
 *
 * `identity` 是旧凭据里与登录无关、但界面要用的字段（user_name 等），
 * 合并进来避免续期一次就丢一次昵称。
 */
export async function refreshCodeArtsCredential(credential, options = {}) {
  if (!isRefreshable(credential)) throw new Error('凭据缺少续期材料，请重新登录')
  const token = await exchangeRefreshToken(
    credential.refresh_token,
    credential.code_verifier,
    credential.dpop_private_key_jwk,
    options.fetcher,
  )
  const refreshed = credentialFromTokenResponse(
    token,
    credential.code_verifier,
    credential.dpop_private_key_jwk,
  )
  if (typeof refreshed.refresh_token !== 'string' || refreshed.refresh_token === '') {
    refreshed.refresh_token = credential.refresh_token
  }
  for (const key of ['domain_id', 'user_id', 'user_name', 'model_rate_limits']) {
    if (credential[key] !== undefined) refreshed[key] = credential[key]
  }
  return refreshed
}

function parseCredentialResponse(data) {
  if (data?.credential) {
    const access = data.credential.access ?? ''
    const st = data.credential.securitytoken ?? data.credential.securityToken ?? ''
    if (access && st) {
      return {
        access_key_id: access,
        secret_access_key: data.credential.secret ?? '',
        security_token: st,
        expires_at: normalizeExpiration(
          data.credential.expires_at ?? data.credential.expiresAt ?? '',
        ),
        domain_id: data.domain_id ?? '',
        user_id: data.user_id ?? '',
        user_name: data.user_name ?? '',
      }
    }
  }
  if (data?.result) {
    const ak = data.result.accessKeyId ?? ''
    const st = data.result.securityToken ?? ''
    if (ak && st) {
      return {
        access_key_id: ak,
        secret_access_key: data.result.secretAccessKey ?? '',
        security_token: st,
        expires_at: normalizeExpiration(data.result.expiration ?? data.result.expiresAt ?? ''),
      }
    }
  }
  return null
}

/** ticket 模式：portal 回跳时带 `secret`，用它换凭据（OAuth 模式不经过这里）。 */
async function pollForCredential(ticketId, secret, fetcher = fetch) {
  const url = `${CREDENTIAL_ENDPOINT}?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`
  for (let attempt = 0; attempt < TICKET_POLL_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(1000)
    let response
    try {
      response = await fetcher(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'plugin-name': TICKET_PLUGIN_NAME,
          'plugin-version': TICKET_PLUGIN_VERSION,
        },
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      })
    } catch {
      continue
    }
    if (!response.ok) continue
    let data
    try {
      data = await response.json()
    } catch {
      continue
    }
    const credential = data === null ? null : parseCredentialResponse(data)
    if (credential !== null) return credential
  }
  throw new Error('CodeArts 登录超时：未取到凭据')
}

function buildPortalLoginResultUrl(succeeded) {
  return `${PORTAL_LOGIN_BASE}?login_succeed=${succeeded}&uri_scheme=${CLIENT_ID}&locale=${OAUTH_LOCALE}`
}

/** 授权地址。`code_challenge_method` 必须是 `SHA-256`（见文件头第 1 条）。 */
function buildAuthorizeUrl(port, pkce, ticketId) {
  const params = new URLSearchParams({
    theme: OAUTH_THEME,
    locale: OAUTH_LOCALE,
    uri_scheme: CLIENT_ID,
    client_id: CLIENT_ID,
    port: String(port),
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'SHA-256',
    ticket_id: ticketId,
    'plugin-name': LOGIN_PLUGIN_NAME,
    'plugin-version': LOGIN_PLUGIN_VERSION,
  })
  return `${PORTAL_AUTHORIZE_BASE}?${params.toString()}`
}

/**
 * 监听回调端口。
 *
 * 先让系统分配，拿到低于 `MIN_CALLBACK_PORT` 的端口就关掉重试——
 * portal 不接受低端口回跳（见文件头第 3 条）。
 */
function listenOnCallbackPort(server) {
  return new Promise((resolve, reject) => {
    const tryListen = port => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        const assigned = typeof address === 'object' && address ? address.port : 0
        if (assigned >= MIN_CALLBACK_PORT) {
          resolve(assigned)
          return
        }
        // 端口太低：关掉，换一个高位随机端口重试。
        server.close(() => {
          tryListen(Math.floor(Math.random() * (65536 - MIN_CALLBACK_PORT)) + MIN_CALLBACK_PORT)
        })
      })
    }
    tryListen(0)
  })
}

function startCallbackServer(ticketId, pkce, privateKeyJwk, fetcher = fetch) {
  let settle
  const result = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort}`)
    if (url.pathname !== REDIRECT_PATH && !url.pathname.startsWith(REDIRECT_PATH)) {
      response.writeHead(404).end('Not found')
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS).end()
      return
    }

    const secret = url.searchParams.get('secret')
    if (secret !== null && secret !== '') {
      // ticket 模式：先跳回 portal，再后台换凭据。
      const redirectTo = url.searchParams.get('redirect') ?? buildPortalLoginResultUrl(true)
      response.writeHead(307, { ...CORS_HEADERS, Location: redirectTo }).end()
      void pollForCredential(ticketId, secret, fetcher).then(
        credential => settle.resolve(credential),
        error => settle.reject(error),
      )
      return
    }

    const code = url.searchParams.get('code')
    if (code !== null && code !== '') {
      void exchangeAuthorizationCode(code, pkce.codeVerifier, request.socket.localPort ?? 0, privateKeyJwk, fetcher)
        .then(
          token => {
            response
              .writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(true) })
              .end()
            settle.resolve(
              credentialFromTokenResponse(token, pkce.codeVerifier, privateKeyJwk),
            )
          },
          error => {
            response
              .writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(false) })
              .end()
            settle.reject(error)
          },
        )
      return
    }

    response.writeHead(400).end('Missing authorization code or secret')
  })

  return listenOnCallbackPort(server).then(port => ({ port, server, result }))
}

/**
 * 启动一次登录：立刻返回授权地址，凭据在 `result` 里异步到达。
 *
 * 两阶段是必须的——前端在点击手势里先占位窗口再导航，等这个函数
 * 拿到 URL 才打开会被浏览器当弹窗拦截。
 *
 * 调用方**必须**在 finally 里 `close()`，否则本地端口会一直占着。
 * 这里也挂了 `.finally(close)` 兜底，但显式调用能让取消路径立刻释放。
 */
export async function startCodeArtsLogin(options = {}) {
  const ticketId = randomBytes(32).toString('hex')
  const pkce = generatePkcePair()
  const keyPair = generateDpopKeyPair()

  const { port, server, result } = await startCallbackServer(
    ticketId,
    pkce,
    keyPair.privateKeyJwk,
    options.fetcher ?? fetch,
  )
  const loginUrl = buildAuthorizeUrl(port, pkce, ticketId)

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await new Promise(resolve => server.close(() => resolve()))
  }

  const guarded = Promise.race([
    result,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('CodeArts 登录超时（3 分钟）')),
        OAUTH_CALLBACK_TIMEOUT_MS,
      )
      timer.unref?.()
    }),
  ])
  guarded.catch(() => {}).finally(() => { void close() })

  return {
    loginUrl,
    port,
    close,
    /** 解析为可直接写入凭据库的字符串与展示用元信息。 */
    result: guarded.then(credential => ({
      credential,
      serialized: JSON.stringify(credential),
      nickname: typeof credential.user_name === 'string' ? credential.user_name : '',
      expiresAt: expiresAtMs(credential) ?? Date.now() + 86_400_000,
      refreshable: isRefreshable(credential),
    })),
  }
}
