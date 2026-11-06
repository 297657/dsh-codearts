/**
 * CodeBuddy（腾讯，中国版）签到。
 *
 * 移植自 2.1.0 版 `vendor/channel-pack/src/credits.ts`，只保留签到路径。
 *
 * ## 协议（逆向 + 真实请求实测）
 *
 *   状态查询  POST {endpoint}/v2/billing/meter/checkin-activity-status  body {}
 *   领取      POST {endpoint}/v2/billing/meter/daily-checkin            body {}
 *
 * ## 三个关键结论（实测，不可省）
 *
 * 1. **必须用 `checkin-activity-status`，不能用 `checkin-status`**。后者返回
 *    占位数据（`active:false`、`checkin_dates:null`），会让人误判「活动未开启」。
 * 2. **不需要 X-Device-Token（图灵盾）**。不带该头的请求真实领取成功。
 * 3. **判定以响应体 `code` 为准，不能只看 HTTP 状态**：重复领取是
 *    HTTP 400 + `code:10001`（"今天已签到"），只看状态码会把幂等误报成失败。
 *
 * ## 能力边界：只有中国版有签到
 *
 * WorkBuddy 国际版（www.workbuddy.ai）**没有签到接口**：`checkin-activity-status`
 * 实测返回 `active:false`、`checkin_dates:null`，其内核里连 `daily-checkin`
 * 字样都不存在。它只有积分余额查询。故本模块只服务 `buddy` 渠道。
 */

const CHECKIN_ACTIVITY_STATUS_PATH = '/v2/billing/meter/checkin-activity-status'
const DAILY_CHECKIN_PATH = '/v2/billing/meter/daily-checkin'
const USER_RESOURCE_PATH = '/v2/billing/meter/get-user-resource'
const REQUEST_TIMEOUT_MS = 30_000

const CODE_ALREADY_CLAIMED = 10001
const CODE_ALREADY_CLAIMED_ALT = 1001
const CODE_NO_QUALIFICATION = 1002
const CODE_ACTIVITY_ENDED = 1003

/** 签到/状态请求头。不含 X-Device-Token（实测非必需）。 */
function checkinHeaders(credential, channel) {
  const headers = {
    Authorization: `Bearer ${credential.access_token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    // 与 2.1.0 `credits.ts` 的 checkinHeaders 对齐：三件套头必须齐。
    // X-Domain 的取值分两种渠道，见 endpointOf()：固定产品域 vs 凭据域名。
    'X-Domain': domainOf(channel, credential),
    'X-Product': 'SaaS',
    'X-Product-Code': channel.productCode,
    'User-Agent': channel.userAgent,
  }
  if (typeof credential.user_id === 'string' && credential.user_id.length > 0) {
    headers['X-User-Id'] = credential.user_id
  }
  if (typeof credential.enterprise_id === 'string' && credential.enterprise_id.length > 0) {
    headers['X-Enterprise-Id'] = credential.enterprise_id
    headers['X-Tenant-Id'] = credential.enterprise_id
  }
  return headers
}

/**
 * 请求该打哪个站点。
 *
 * - `endpointFrom: 'domain'`（WorkBuddy）：跟随凭据里的 `domain`，缺失时退回
 *   产品默认域。同一个 provider 有 `.ai` / `.cn` 两侧账号，把 `.cn` 账号的请求
 *   发到 `.ai` 只会 401，所以这里必须跟着凭据走。
 * - 其余渠道（CodeBuddy）：用产品固定域。凭据的 `domain` 只是「登录时用的域名」
 *   快照，跟着它走会把身份标识发错区域。
 */
function domainOf(channel, credential) {
  if (channel.endpointFrom === 'domain') {
    const domain = typeof credential.domain === 'string' ? credential.domain.trim() : ''
    return domain.length > 0 ? domain : channel.apiDomain
  }
  return channel.apiDomain
}

function endpointOf(channel, credential) {
  return channel.endpointFrom === 'domain'
    ? `https://${domainOf(channel, credential)}`
    : channel.endpoint
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

function readStringArray(source, key) {
  const value = source[key]
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

/**
 * 发起一次签到请求并解析 JSON。
 *
 * ⚠️ 不用 `response.json()`：凭据失效时腾讯网关返回 **HTML 错误页**，
 * `json()` 会抛 `Unexpected token '<'`——这条消息对用户毫无意义，
 * 也看不出真正原因是「凭据过期」。先取文本再解析，非 JSON 时带上状态码。
 */
async function postJson(path, credential, channel) {
  const endpoint = endpointOf(channel, credential)
  let response
  try {
    response = await fetch(`${endpoint}${path}`, {
      method: 'POST',
      headers: checkinHeaders(credential, channel),
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, message: `网络请求失败：${error?.message ?? String(error)}` }
  }

  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `凭据已失效（HTTP ${response.status}），请重新登录该账号` }
    }
    const snippet = text.trim().slice(0, 80).replace(/\s+/g, ' ')
    return { ok: false, message: `服务端返回了非 JSON 响应（HTTP ${response.status}）：${snippet}` }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, message: '请求失败或响应无法解析' }
  }
  return { ok: true, body: parsed }
}

/** 只读查询签到状态。 */
export async function fetchBuddyStatus(credential, channel) {
  const result = await postJson(CHECKIN_ACTIVITY_STATUS_PATH, credential, channel)
  if (!result.ok) return { state: 'error', message: result.message }

  const body = result.body
  if (body.code !== 0) {
    const message = readString(body, 'msg')
    return { state: 'error', message: message || `业务码 ${body.code}` }
  }
  const data = body.data
  if (typeof data !== 'object' || data === null) {
    return { state: 'error', message: '响应缺少 data 字段' }
  }

  const active = readBool(data, 'active')
  const todayCheckedIn = readBool(data, 'today_checked_in')
  const streakDays = readNumber(data, 'streak_days')
  const dailyCredit = readNumber(data, 'daily_credit')
  const totalCredits = readNumber(data, 'total_credits')
  const activityName = readString(data, 'activity_name')
  const checkinDates = readStringArray(data, 'checkin_dates')

  if (!active) {
    return {
      state: 'inactive',
      message: `该账号（${endpointOf(channel, credential)?.replace('https://', '') ?? '未知站点'}）当前没有可参与的签到活动`,
      streakDays,
      checkinDates,
    }
  }
  return {
    state: todayCheckedIn ? 'checked-in' : 'claimable',
    message: todayCheckedIn ? '今天已签到' : (activityName || '可签到'),
    amount: dailyCredit,
    streakDays,
    totalCredits,
    checkinDates,
  }
}

/** 精确金额：服务端把小数放在 `*Precise` 字符串里，基础字段只有整数。 */
function readPrecise(source, key) {
  const precise = source[`${key}Precise`]
  if (typeof precise === 'string' && precise.trim() !== '') {
    const parsed = Number.parseFloat(precise)
    if (Number.isFinite(parsed)) return parsed
  }
  if (typeof precise === 'number' && Number.isFinite(precise)) return precise
  return readNumber(source, key)
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/** 过期判断用的状态值（与 2.1.0 的 `credits.ts` 一致）。 */
const PACKAGE_STATUS_EXPIRED = 3
/** 「即将过期」的窗口：7 天内的余额值得提醒。 */
const EXPIRING_WINDOW_MS = 7 * 86_400_000

/**
 * 解析 `get-user-resource` 的积分包列表。
 *
 * 返回 `undefined` 表示「这份响应里没有积分信息」——与「积分为 0」不同，
 * 界面该显示「—」而不是「剩余 0」（后者会让人以为额度用光了）。
 *
 * 结构（实测）：`data.Response.Data.Accounts[]`，每个元素是一个积分包：
 * `PackageName` / `CycleCapacitySize|Remain|Used`（含 `*Precise` 小数串）/
 * `Status`（3 = 已过期）/ `ExpiredTime` / `DeductionEndTime`。
 */
export function parseBuddyCredit(body, now = Date.now()) {
  const accounts = body?.data?.Response?.Data?.Accounts
  if (!Array.isArray(accounts)) return undefined

  const packages = []
  let remainTotal = 0
  let sizeTotal = 0
  let usedTotal = 0
  let expiring = 0

  for (const entry of accounts) {
    if (typeof entry !== 'object' || entry === null) continue
    const name = readString(entry, 'PackageName')
      || readString(entry, 'SubProductName')
      || readString(entry, 'PackageCode')
      || '积分包'
    const expiredTime = readString(entry, 'ExpiredTime')
    const deductionEndTime = readNumber(entry, 'DeductionEndTime')
    const expiredAt = expiredTime === '' ? Number.NaN : Date.parse(expiredTime.replace(' ', 'T'))
    const active = entry.Status !== PACKAGE_STATUS_EXPIRED
      && !(Number.isFinite(expiredAt) && now >= expiredAt)
      && !(deductionEndTime > 0 && now >= deductionEndTime)

    const remaining = readPrecise(entry, 'CycleCapacityRemain')
    const size = readPrecise(entry, 'CycleCapacitySize')
    const used = readPrecise(entry, 'CycleCapacityUsed')
    // 已过期且没剩额度：列出来只是噪音。
    if (!active && remaining <= 0) continue

    packages.push({
      name,
      total: round2(size),
      used: round2(used),
      remaining: round2(remaining),
      active,
      ...(Number.isFinite(expiredAt) ? { expiredAt } : {}),
    })
    sizeTotal += size
    usedTotal += used
    if (active) {
      remainTotal += remaining
      if (Number.isFinite(expiredAt) && expiredAt - now <= EXPIRING_WINDOW_MS) expiring += remaining
    }
  }

  return {
    // `total` 与 CodeArts 那边同义：**可用**剩余（过期包不计入）。
    total: round2(remainTotal),
    ...(sizeTotal > 0 ? { amount: round2(sizeTotal) } : {}),
    ...(usedTotal > 0 ? { used: round2(usedTotal) } : {}),
    ...(expiring > 0 ? { expiring: round2(expiring) } : {}),
    packages,
  }
}

/**
 * 只读查询积分余额。
 *
 * 失败一律返回 `undefined`：余额是「顺带看到的」，它挂了不该把签到状态也拖成错误。
 * WorkBuddy 国际版也走这个端点（它没有签到接口，只有余额）。
 */
export async function fetchBuddyCredit(credential, channel) {
  const result = await postJson(USER_RESOURCE_PATH, credential, channel)
  if (!result.ok) return undefined
  if (result.body.code !== 0) return undefined
  return parseBuddyCredit(result.body)
}

/** 执行一次签到领取。 */
export async function claimBuddy(credential, channel) {
  const result = await postJson(DAILY_CHECKIN_PATH, credential, channel)
  if (!result.ok) return { kind: 'failed', message: result.message }

  const body = result.body
  const code = typeof body.code === 'number' ? body.code : -1
  const message = readString(body, 'msg')

  if (code === CODE_ALREADY_CLAIMED || code === CODE_ALREADY_CLAIMED_ALT) {
    return { kind: 'already-claimed', message: message || '今天已签到' }
  }
  if (code === CODE_NO_QUALIFICATION || code === CODE_ACTIVITY_ENDED) {
    return { kind: 'inactive', message: message || '当前无领取资格' }
  }
  if (code !== 0) {
    return { kind: 'failed', message: message || `领取失败（code=${code}）` }
  }

  const data = body.data
  if (typeof data !== 'object' || data === null) {
    return { kind: 'failed', message: '领取响应缺少 data 字段' }
  }
  const delayed = readString(data, 'message')
  return {
    kind: 'claimed',
    credit: readNumber(data, 'credit'),
    streakDays: readNumber(data, 'streak_days'),
    isStreakDay: readBool(data, 'is_streak_day'),
    ...(delayed.length > 0 ? { warning: delayed } : {}),
  }
}
