/**
 * 华为云的 `SDK-HMAC-SHA256` 请求签名。
 *
 * 这套算法和 AWS SigV4 同源但不完全一样，容易踩的几处：
 *  - 待签名串只有三行（算法、时间戳、canonical hash），**没有** credential scope；
 *  - `Authorization` 里的 `Access=` 是 AK 本身，不拼 AKID/date/region/service；
 *  - canonical URI 末尾必须补一个 `/`，否则网关会把 `/api/v2/chat/completions`
 *    和 `/api/v2/chat/completions/` 当成两条不同的签名路径，回 401；
 *  - query string 原样参与签名，**不排序也不重新编码**；
 *  - 参与签名的头一律小写，且 `content-type` 只在非 GET 时加入。
 *
 * 以上都与 2.1.0 的 `vendor/channel-pack/src/sign.ts` 对齐——那份实现是被真实
 * 网关验证过的，这里不"优化"它的任何取舍。
 *
 * 临时凭据（AK/SK + security_token）由 OAuth 换得，两小时一换，见 codearts-login.js。
 */

import { createHash, createHmac } from 'node:crypto'

const sha256Hex = data => createHash('sha256').update(data).digest('hex')

/** `20261104T083000Z` —— 华为云要求的 ISO 去分隔符形式。 */
export function sdkDateStamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/**
 * 生成签好的请求头。
 *
 * @param {object} input
 * @param {string} input.ak 临时 AccessKeyId
 * @param {string} input.sk 临时 SecretAccessKey
 * @param {string} input.securityToken 临时 SecurityToken
 * @param {string} input.method HTTP 方法
 * @param {string} input.url 完整 URL（query 参与签名）
 * @param {string|Uint8Array} [input.body] 请求体，参与 `x-sdk-content-sha256`
 * @param {Record<string,string>} [input.extraHeaders] 额外参与签名的头（如 `maas_type`）
 * @param {Date} [input.now] 仅测试用；生产留空
 * @returns {Record<string,string>} 小写头名 → 值，含 `Authorization`
 */
export function signHuaweiRequest({
  ak,
  sk,
  securityToken,
  method,
  url,
  body = '',
  extraHeaders,
  now,
}) {
  if (typeof ak !== 'string' || ak === '') throw new Error('signHuaweiRequest: 缺少 ak')
  if (typeof sk !== 'string' || sk === '') throw new Error('signHuaweiRequest: 缺少 sk')

  const parsed = new URL(url)
  let uri = parsed.pathname
  if (!uri.endsWith('/')) uri += '/'
  const query = parsed.search.slice(1)

  const dateStamp = sdkDateStamp(now)
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
  const payloadHash = sha256Hex(payload)

  /** @type {Map<string,string>} */
  const headers = new Map()
  headers.set('host', parsed.host)
  headers.set('x-sdk-date', dateStamp)
  headers.set('x-sdk-content-sha256', payloadHash)
  // 永久 AK 没有 security_token，此时不发该头，也不能让它进签名列表。
  if (typeof securityToken === 'string' && securityToken !== '') {
    headers.set('x-security-token', securityToken)
  }
  if (extraHeaders !== undefined) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      // ⚠️ 必须转小写。华为云要求 SignedHeaders 全小写，传 `Content-Type` 这种
      // 大写形式会让验签失败并回一个含糊的 401 APIG.0301（早期实测踩过）。
      headers.set(key.toLowerCase(), String(value))
    }
  }
  if (method.toUpperCase() !== 'GET') headers.set('content-type', 'application/json')

  const signedHeaders = [...headers.keys()].sort()
  const headerLines = signedHeaders.map(name => `${name}:${headers.get(name) ?? ''}`)
  const canonicalRequest = [
    method.toUpperCase(),
    uri,
    query,
    headerLines.join('\n'),
    '', // canonical headers 与 signed headers 之间必须有一个空行
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n')

  const stringToSign = [
    'SDK-HMAC-SHA256',
    dateStamp,
    sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n')

  const signature = createHmac('sha256', Buffer.from(sk, 'utf8'))
    .update(stringToSign, 'utf8')
    .digest('hex')

  const out = Object.fromEntries(headers)
  out.authorization = `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders.join(';')},Signature=${signature}`
  return out
}

/**
 * 把 `signHuaweiRequest` 的结果转成可直接喂给 `fetch` 的 Headers。
 *
 * `host` 不能手动设置（fetch 会拒绝或忽略），所以剔掉；其余原样保留。
 * 注意 `Authorization` 的大小写无所谓——HTTP 头名不区分大小写。
 */
export function toFetchHeaders(signed) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(signed)) {
    if (key === 'host') continue
    headers.set(key, value)
  }
  return headers
}
