/**
 * 从 CodeArts 凭据里解析「这是哪个华为云账号」。
 *
 * 为什么需要它：华为云的积分额度是**账号级**的，而本机的账号池是「登录一次
 * 就多一行」。用同一个华为云账号在已登录的浏览器里再授权一次，会拿到全新的
 * 临时 AK/SK（长得完全不像重复），于是同一个账号在列表里出现两行、余额显示
 * 两遍、标题行还把两份余额加了起来——用户看到的就是「积分不准确」。
 *
 * 判重只能靠身份，不能靠 AK/SK。身份在 `refresh_token` 的 JWT 声明里：
 * `user_profile` 是一段 base64url 的 JSON，含 `account_id` / `account_name` /
 * `principal_id`。`account_id` 就是华为云账号（租户）标识——同一租户下的不同
 * IAM 用户共享同一份积分额度，所以按 `account_id` 判重才是对的。
 *
 * 只读、不校验签名：这里读的是自己刚拿到的令牌，用途仅是「给用户看这是哪个
 * 账号」。不解析签名也就不会因为 JWK 形态变化而失效。
 */

/** base64url 片段 → JSON。段内可能缺 padding，Node 的 base64url 能容忍。 */
function segmentJson(segment) {
  try {
    const text = Buffer.from(segment, 'base64url').toString('utf8')
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 解出 JWT 的声明；不是 JWT 就返回 undefined。 */
export function decodeJwtClaims(token) {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  return segmentJson(parts[1])
}

/** 依次尝试的字段：refresh_token 寿命最长，access_token 未必落在凭据里。 */
const TOKEN_KEYS = ['refresh_token', 'access_token', 'id_token']

function readString(source, key) {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 解析凭据对应的华为云账号。
 *
 * 返回 `undefined` 表示「解析不出来」——老凭据、令牌形态变了都会走到这里。
 * 调用方必须把 `undefined` 当成「无法判重」，而不是「不是重复」。
 */
export function codeArtsIdentity(credential) {
  if (typeof credential !== 'object' || credential === null) return undefined

  for (const tokenKey of TOKEN_KEYS) {
    const claims = decodeJwtClaims(credential[tokenKey])
    if (claims === undefined) continue

    let profile = claims.user_profile
    if (typeof profile === 'string') profile = segmentJson(profile)
    if (typeof profile !== 'object' || profile === null) continue

    const accountId = readString(profile, 'account_id')
    const accountName = readString(profile, 'account_name')
    const principalId = readString(profile, 'principal_id')
    // 判重键优先 account_id（积分归属），退到 principal_id（单 IAM 用户的旧令牌）。
    const key = accountId !== '' ? accountId : principalId
    if (key === '') continue

    return {
      key,
      accountId,
      accountName,
      principalId,
      /** 界面上显示什么：账号名 > IAM 用户名 > 账号 id。 */
      name: accountName !== '' ? accountName : principalId !== '' ? principalId : accountId,
    }
  }
  return undefined
}
