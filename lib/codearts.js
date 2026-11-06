/**
 * CodeArts 签到（华为云「每日签到领积分」活动）。
 *
 * 移植自 2.1.0 版 `vendor/channel-pack/src/codearts-credits.ts`，
 * 只保留签到路径，去掉余额/资源包/UI 相关部分。
 *
 * ## 协议（逆向自码道 IDE，非猜测）
 *
 *   账户/套餐  GET  {snap}/snap-manager/v1/statistics/plugin
 *   活动列表   GET  {snap}/v1/ops/delivery?channel=IDE
 *   领取       POST {snap}/v1/ops/claim   { campaignId, channel: 'IDE' }
 *   领取确认   POST {snap}/v1/ops/confirm { campaignId }
 *
 * ## 认证：签名，不是 Cookie
 *
 * portal 网页版走浏览器会话 Cookie，插件没有；IDE 直连的 snap-access 端点
 * 接受 `SDK-HMAC-SHA256` 签名，凭据就是现有的 AK/SK/security_token。
 *
 * ## 三个关键细节（都是 2.1.0 踩过的坑，不可省）
 *
 * 1. `Agent-Type` / `X-Language` **必须在签名之后追加**。放进 canonical request
 *    会让服务端回 `401 APIG.0301 verify ak sk signature fail`。
 * 2. `campaignId` 服务端下发的是**数字**，按字符串解析会得到空串，
 *    领取被判为「缺少 campaignId」。
 * 3. 领取后若响应 `id !== null`，必须补一次 `confirm`，否则积分停在「待确认」。
 */

import { signHuaweiRequest, toFetchHeaders } from './sigv4.js'

const SNAP_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com'
const PACKAGE_INFO_PATH = '/snap-manager/v1/statistics/plugin'
const OPS_DELIVERY_PATH = '/v1/ops/delivery'
const OPS_CLAIM_PATH = '/v1/ops/claim'
const OPS_CONFIRM_PATH = '/v1/ops/confirm'
const OPS_CHANNEL = 'IDE'
const DAILY_LOGIN_TYPE = 'USER_LOGIN'
const CLAIMED_STATUSES = ['CLAIMED', 'CONFIRMED', 'CONSUMED']
const REQUEST_TIMEOUT_MS = 30_000

/**
 * 积分指标名 → 展示名。
 *
 * `statistics/plugin` 的 `metrics` 里，`usage*PackageCredit` 这几行才是积分包；
 * 其余（token 用量等）不参与。`usageTotalPackageCredit` 是**总计**，它的
 * `package_credit_remain` 就是界面要的「剩余积分」——实测 14600 总额度、
 * 已用 6581.42、剩余 8018.58，与总包 = 基础包 + 赠送包 自洽。
 */
const CREDIT_METRIC_LABELS = {
  usageTotalPackageCredit: '总积分包',
  usageBasicPackageCredit: '基础积分包',
  usageOnDemandPackageCredit: '按需积分包',
  usageBonusPackageCredit: '赠送积分包',
}
const TOTAL_CREDIT_METRIC = 'usageTotalPackageCredit'

/** 签名后追加、**不参与签名计算**的头（见文件头第 1 条）。 */
const SNAP_EXTRA_HEADERS = {
  'Agent-Type': 'PromptCenter',
  'X-Language': 'zh-cn',
}

function readBool(source, key) {
  return source[key] === true
}

function readString(source, key) {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

function readNumber(source, key) {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 读取数字或字符串形态的标识符（campaignId 实测是数字）。 */
function readIdentifier(source, key) {
  const value = source[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 把响应整理成 { ok, data } 或 { ok:false, message }。 */
function unwrapEnvelope(raw) {
  if (typeof raw.code === 'number') {
    if (raw.code !== 0) {
      const message = readString(raw, 'message') || readString(raw, 'msg')
      return { ok: false, message: message || `业务码 ${raw.code}` }
    }
    const data = raw.data
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) return { ok: true, data }
    return { ok: false, message: '响应缺少 data 字段' }
  }
  // 无 code 字段：statistics/plugin 是裸对象形态。
  return { ok: true, data: raw }
}

/** 带签名地请求一次 snap-access。 */
async function signedRequest(method, url, credential, body) {
  const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential
  if (!ak || !sk || !st) return { ok: false, message: '凭据缺少 AK/SK/SecurityToken' }

  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(body, 'utf8')
  // 签名**不含** SNAP_EXTRA_HEADERS（见文件头第 1 条）。
  const signed = signHuaweiRequest({ ak, sk, securityToken: st, method, url, body: payload })

  // `host` 由运行时按实际连接目标生成，手工设置会被 fetch 忽略（toFetchHeaders 已剔除）。
  const headers = toFetchHeaders(signed)
  // 这些头签名后追加，不参与 canonical 计算——见文件头第 1 条。
  for (const [key, value] of Object.entries(SNAP_EXTRA_HEADERS)) headers.set(key, value)

  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, message: `网络请求失败：${error?.message ?? String(error)}` }
  }

  const text = await response.text()
  if (!response.ok) {
    // 把服务端错误码带出来：401 时的报文直接指出「签名头放错位置」。
    let detail = text.trim().slice(0, 200).replace(/\s+/g, ' ')
    try {
      const parsed = JSON.parse(text)
      const code = parsed?.error_code
      const msg = parsed?.error_msg
      if (typeof code === 'string' || typeof msg === 'string') detail = `${code ?? ''} ${msg ?? ''}`.trim()
    } catch { /* 保持原文片段 */ }
    return { ok: false, message: `HTTP ${response.status}：${detail}` }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, message: '响应不是 JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: '响应不是对象' }
  }
  return unwrapEnvelope(parsed)
}

/** 数字或数字字符串都接受（服务端两种形态都出现过）。 */
function readAmount(source, key) {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * 从 `metrics` 里解析积分包余额。
 *
 * 返回 `undefined` 表示「这份响应里没有积分指标」——与「积分为 0」是两件事，
 * 不能混：没有指标时界面该显示「—」，而不是「剩余 0 分」（后者会让人以为额度用光了）。
 */
export function parseCreditBalance(metrics) {
  if (!Array.isArray(metrics)) return undefined
  const packages = []
  let totalRemain
  let totalAmount
  let totalUsed
  let expiring = 0
  let sawAny = false

  for (const item of metrics) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const name = readString(item, 'name')
    const label = CREDIT_METRIC_LABELS[name]
    if (label === undefined) continue
    sawAny = true
    const amount = readAmount(item, 'package_credit_amount')
    const used = readAmount(item, 'package_credit_used')
    const remain = readAmount(item, 'package_credit_remain')
    if (name === TOTAL_CREDIT_METRIC) {
      totalRemain = remain
      totalAmount = amount
      totalUsed = used
      expiring = readAmount(item, 'package_credit_expiring_amount')
    }
    if (amount <= 0 && remain <= 0) continue
    packages.push({ name: label, total: round2(amount), used: round2(used), remaining: round2(remain) })
  }

  if (!sawAny) return undefined
  const total = round2(
    totalRemain ?? packages.reduce((sum, pkg) => sum + pkg.remaining, 0),
  )
  return {
    total,
    ...totalAmount === undefined ? {} : { amount: round2(totalAmount) },
    ...totalUsed === undefined ? {} : { used: round2(totalUsed) },
    ...expiring > 0 ? { expiring: round2(expiring) } : {},
    packages,
  }
}

/** 查询账户/套餐信息（积分计费判定 + 剩余积分）。 */
async function fetchAccountInfo(credential) {
  const result = await signedRequest('GET', `${SNAP_BASE}${PACKAGE_INFO_PATH}`, credential, undefined)
  if (!result.ok) return result
  const pkg = result.data.package
  const record = typeof pkg === 'object' && pkg !== null ? pkg : {}
  return {
    ok: true,
    data: {
      isCreditPackage: readBool(record, 'is_credit_package'),
      isTokenPackage: readBool(record, 'is_token_package'),
      packageName: readString(record, 'package_name_cn') || readString(record, 'package_name_en'),
      status: readString(record, 'status'),
      credit: parseCreditBalance(result.data.metrics),
    },
  }
}

/** 只查余额（设置页「刷新余额」用）。 */
export async function fetchCodeArtsCredit(credential) {
  const info = await fetchAccountInfo(credential)
  if (!info.ok) return { ok: false, message: info.message }
  return {
    ok: true,
    credit: info.data.credit,
    packageName: info.data.packageName,
    packageStatus: info.data.status,
    isCreditPackage: info.data.isCreditPackage,
  }
}

/** 查询活动列表。 */
async function fetchActivities(credential) {
  const url = `${SNAP_BASE}${OPS_DELIVERY_PATH}?channel=${OPS_CHANNEL}`
  const result = await signedRequest('GET', url, credential, undefined)
  if (!result.ok) return result
  const items = result.data.items
  if (!Array.isArray(items)) return { ok: false, message: '响应缺少 items 字段' }
  return {
    ok: true,
    data: items
      .filter(item => typeof item === 'object' && item !== null && !Array.isArray(item))
      .map(item => ({
        campaignId: readIdentifier(item, 'campaignId'),
        type: readString(item, 'type'),
        title: readString(item, 'title'),
        claimable: readBool(item, 'claimable'),
        status: readString(item, 'status'),
        amount: readNumber(item, 'benefitAmount')
          || readNumber(item, 'amount')
          || readNumber(item, 'creditAmount'),
      })),
  }
}

/** 只读查询签到状态，不产生任何写入。 */
export async function fetchCodeArtsStatus(credential) {
  // 两个查询彼此独立（一个是套餐+余额，一个是活动列表），并行发能省掉一整个 RTT：
  // 设置页每次打开都要跑一遍，串行的等待是「进页面很慢」的主要来源。
  const [info, activities] = await Promise.all([
    fetchAccountInfo(credential),
    fetchActivities(credential),
  ])
  if (!info.ok) return { state: 'error', message: `账户信息查询失败：${info.message}` }
  const credit = info.data.credit
  // 余额是「顺带拿到的」：签到状态与它无关，有就带上，没解析出来就不带。
  const attach = row => (credit === undefined ? row : { ...row, credit })
  if (!info.data.isCreditPackage) {
    return attach({
      state: 'inactive',
      message: info.data.isTokenPackage
        ? `Token 计费账户（${info.data.packageName || '未命名套餐'}），不在积分活动范围`
        : `非积分计费账户（${info.data.packageName || '未命名套餐'}），不在积分活动范围`,
    })
  }

  if (!activities.ok) return attach({ state: 'error', message: `活动列表查询失败：${activities.message}` })

  const activity = activities.data.find(item => item.type === DAILY_LOGIN_TYPE)
  if (activity === undefined) return attach({ state: 'inactive', message: '未找到每日签到活动' })

  if (!activity.claimable) {
    return attach(CLAIMED_STATUSES.includes(activity.status)
      ? { state: 'checked-in', message: '今天已签到', amount: activity.amount }
      : { state: 'inactive', message: `当前不可领取（status=${activity.status}）`, amount: activity.amount })
  }
  return attach({
    state: 'claimable',
    message: activity.title || '每日签到',
    amount: activity.amount,
    campaignId: activity.campaignId,
  })
}

/**
 * 执行一次签到。
 *
 * 幂等保护只有「活动列表的 claimable/status 预检」这一层：本协议没有幂等键，
 * 也没有「今天已签到」业务码可依赖，所以预检不能省。
 */
export async function claimCodeArts(credential) {
  const info = await fetchAccountInfo(credential)
  if (!info.ok) return { kind: 'failed', message: `账户信息查询失败：${info.message}` }
  if (!info.data.isCreditPackage) {
    return {
      kind: 'inactive',
      message: info.data.isTokenPackage
        ? `Token 计费账户（${info.data.packageName || '未命名套餐'}），不在积分活动范围`
        : `非积分计费账户（${info.data.packageName || '未命名套餐'}），不在积分活动范围`,
    }
  }

  const activities = await fetchActivities(credential)
  if (!activities.ok) return { kind: 'failed', message: `活动列表查询失败：${activities.message}` }

  const activity = activities.data.find(item => item.type === DAILY_LOGIN_TYPE)
  if (activity === undefined) return { kind: 'inactive', message: '未找到每日签到活动' }

  if (!activity.claimable) {
    return CLAIMED_STATUSES.includes(activity.status)
      ? { kind: 'already-claimed', message: '今天已领取', credit: 0 }
      : { kind: 'inactive', message: `当前不可领取（status=${activity.status}）` }
  }
  if (activity.campaignId.length === 0) {
    return { kind: 'failed', message: '活动缺少 campaignId，无法领取' }
  }

  const claim = await signedRequest(
    'POST',
    `${SNAP_BASE}${OPS_CLAIM_PATH}`,
    credential,
    JSON.stringify({ campaignId: activity.campaignId, channel: OPS_CHANNEL }),
  )
  if (!claim.ok) return { kind: 'failed', message: claim.message }

  // 服务端要求确认时才补 confirm（判据对齐 IDE 的 `benefit.id !== null`）。
  // confirm 失败不把整体判为失败：积分已进入待确认态，报失败会让用户重复点击。
  const benefitId = claim.data.id
  let confirmWarning
  if (benefitId !== null && benefitId !== undefined) {
    const confirm = await signedRequest(
      'POST',
      `${SNAP_BASE}${OPS_CONFIRM_PATH}`,
      credential,
      JSON.stringify({ campaignId: activity.campaignId }),
    )
    if (!confirm.ok) confirmWarning = `领取已提交，但确认步骤失败：${confirm.message}`
  }

  const credit = readNumber(claim.data, 'benefitAmount')
    || readNumber(claim.data, 'credit')
    || readNumber(claim.data, 'credits')
    || readNumber(claim.data, 'creditAmount')
    || readNumber(claim.data, 'amount')

  return {
    kind: 'claimed',
    credit: credit > 0 ? credit : activity.amount,
    ...(confirmWarning === undefined ? {} : { warning: confirmWarning }),
  }
}
