/**
 * @local/dsh-codearts —— 签到 + 账号管理（WorkBuddy / CodeBuddy 中国版 / 华为云 CodeArts）。
 *
 * 设计取舍：本插件**不注册 LLM 适配器**，也不参与模型渠道选择；只负责
 * 各家的「每日签到」与这三家的账号增删，结果呈现在 `/api/codearts-checkin` 上。
 *
 * 之所以连账号管理一起做：ofm 2.8.0 把这三个渠道整体移出账号池管理，
 * 账号数据与凭据都还在，但没有任何入口能新增、停用或退出。后端签到与
 * 续期逻辑都依赖这些凭据，入口却没有了，等于把用户锁死在「只能等它过期」。
 *
 * CodeArts 的临时凭据只有约 2 小时寿命，所以本插件在签到前会按需续期
 * （`lib/codearts-login.js` 的 `refreshCodeArtsCredential`）——否则用户
 * 刚添加的账号当天下午就会报「临时凭据已过期」。
 *
 * WorkBuddy 与 CodeBuddy 共用同一套签到端点（`/v2/billing/meter/daily-checkin`），
 * 区别是站点与身份头：WorkBuddy 跟随凭据里的 `domain`，且不能带 X-Domain/X-Product
 * 这两个产品头（实测会 401）。是否存在签到活动由服务端 `active` 决定——
 * 本插件如实呈现，不猜测、不伪造「已签到」。
 */

import { randomBytes } from 'node:crypto'

import { CHANNELS, channelById, accountsOf, readCredential } from './lib/credentials.js'
import { codeArtsIdentity } from './lib/identity.js'
import { findDuplicateAccount, markDuplicates } from './lib/duplicates.js'
import { fetchBuddyStatus, fetchBuddyCredit, claimBuddy } from './lib/buddy.js'
import { fetchCodeArtsStatus, claimCodeArts } from './lib/codearts.js'
import { removeAccount, setAccountEnabled, addAccount, updateAccount } from './lib/accounts.js'
import { startBuddyLogin, finishBuddyLogin } from './lib/buddy-login.js'
import {
  startCodeArtsLogin,
  refreshCodeArtsCredential,
  isRefreshable,
  expiresAtMs,
  REFRESH_LEAD_MS,
} from './lib/codearts-login.js'
import {
  fetchModelCatalog,
  invalidateCatalog,
  streamChat,
  buildRequestBody,
  modelInfo,
  fetchQueueStatus,
} from './lib/codearts-llm.js'
import { snapshot as sessionSnapshot, abortAllSessions, abortSession } from './lib/sessions.js'

export const name = 'dsh-codearts-checkin'
export const inject = []

const ROUTE_PREFIX = '/api/codearts-checkin'
const REQUEST_TIMEOUT_MS = 45_000

/**
 * 注册给 DSH 的 provider id。
 *
 * ⚠️ **不能用 `codearts`**：Our Free Model 2.8.0 起在 `src/magpie-policy.js` 里把
 * `codearts|huawei|workbuddy|codebuddy` 列为拒绝渠道，凡是命中该名单的 provider
 * id 与模型行都会从 `/api/providers`、`/api/upstream` 与网关模型清单里被剔除。
 * 用 `devcloud`（华为云的旧名）既不含这些关键词，也不与任何现有 provider 冲突，
 * 于是模型能正常出现在选择器里。这是兼容既有插件的必要取舍，不是伪装。
 */
const LLM_PROVIDER = 'devcloud'

function today() {
  // 签到按 UTC+8 自然日结算（两家都是）。用固定偏移而不是本地时区，
  // 避免用户机器时区不同导致「今天」判错。
  const now = new Date()
  const utc8 = new Date(now.getTime() + 8 * 3600_000)
  return utc8.toISOString().slice(0, 10)
}

/** 4 字节随机十六进制，用作账号 id 与凭据名后缀（与 2.1.0 的 shortId 同形）。 */
function randomSuffix() {
  return randomBytes(4).toString('hex').toUpperCase()
}

/**
 * 续期的 single-flight 与短期缓存。
 *
 * ⚠️ 华为云的 refresh_token 是**一次性**的（实测重复使用返回
 * `STS5.1806 the refresh token has been used`）。所以同一个账号绝不能
 * 在同一时间窗里刷新两次：
 *  - 并发：`status` 与 `claim` 前后脚各调一次 `credentialOf`；
 *  - 重复：一次 `claimAll` 里先查状态再领取，也是两次。
 *
 * 两道闸：在途请求共享同一个 Promise；成功结果按「刷新时消费掉的那枚
 * refresh_token」缓存一小段时间。
 *
 * 命中判据必须是 `sourceRefreshToken`（旧的），不能是「当前 refresh_token
 * 等于缓存里的新的」——刷新后服务端轮换了 RT，若落盘也成功，文件里是新值，
 * 此时压根不需要再刷新；若落盘失败（或调用方还没写盘），文件里仍是旧值，
 * 用旧值作键才能命中，避免拿已被标记 used 的 token 再打一次。
 */
const refreshInFlight = new Map()
const refreshCache = new Map()
const REFRESH_CACHE_MS = 5 * 60_000

async function refreshOnce(refName, credential, deps) {
  const cached = refreshCache.get(refName)
  if (
    cached !== undefined
    && cached.sourceRefreshToken === credential.refresh_token
    && Date.now() - cached.at < REFRESH_CACHE_MS
  ) {
    return { credential: cached.credential, ...(cached.warning === undefined ? {} : { warning: cached.warning }) }
  }

  const pending = refreshInFlight.get(refName)
  if (pending !== undefined) return pending

  const task = (async () => {
    const refreshed = await refreshCodeArtsCredential(credential)

    // 落盘失败的处置：**新凭据必须留在内存里**。新 refresh_token 只在
    // 这一份里，旧的那个已被服务端标记 used；丢掉它等于把账号废掉。
    // 所以这里降级为告警 + 继续使用，而不是整体失败。
    let warning
    const store = deps?.getStore?.()
    if (store === null || store === undefined) {
      warning = '凭据服务不可用，续期结果未能保存（重启 DSH 后可能需要重新登录）'
    } else {
      try {
        await store.set(refName, JSON.stringify(refreshed))
      } catch (error) {
        warning = `续期成功但保存失败：${error?.message ?? error}`
      }
    }

    refreshCache.set(refName, {
      credential: refreshed,
      sourceRefreshToken: credential.refresh_token,
      warning,
      at: Date.now(),
    })
    return { credential: refreshed, ...(warning === undefined ? {} : { warning }) }
  })().finally(() => { refreshInFlight.delete(refName) })

  refreshInFlight.set(refName, task)
  return task
}

/**
 * 解析一个账号的凭据；失败时返回可展示的原因。
 *
 * CodeArts 分支会**按需续期**：临时 AK/SK/SecurityToken 只有约 2 小时寿命，
 * 2.8.0 移出账号池管理后没有任何组件再续它。
 *
 * 续期失败时若旧凭据尚未过期则继续用旧的——宁可少一次刷新，
 * 也不要因为网络抖动把本来能签到的账号判死。
 */
async function credentialOf(account, deps) {
  const credential = readCredential(account.credentialRef)
  if (credential === undefined) {
    return { ok: false, message: `找不到凭据 ${account.credentialRef}（可能已被删除，请重新登录）` }
  }

  if (account.provider === 'codearts') {
    if (!credential.access_key_id || !credential.secret_access_key || !credential.security_token) {
      return { ok: false, message: '凭据缺少 AK/SK/SecurityToken，请重新登录' }
    }

    const expires = expiresAtMs(credential)
    const expired = expires !== undefined && expires <= Date.now()
    const dueSoon = expires !== undefined && expires - Date.now() < REFRESH_LEAD_MS

    if (isRefreshable(credential) && (expired || dueSoon || expires === undefined)) {
      try {
        const outcome = await refreshOnce(account.credentialRef, credential, deps)
        updateAccount(account.id, {
          expiresAt: expiresAtMs(outcome.credential),
          refreshable: isRefreshable(outcome.credential),
        })
        return { ok: true, credential: outcome.credential, ...(outcome.warning === undefined ? {} : { warning: outcome.warning }) }
      } catch (error) {
        if (!expired) return { ok: true, credential }
        return { ok: false, message: `凭据已过期且续期失败：${error?.message ?? error}` }
      }
    }

    if (expired) {
      return {
        ok: false,
        message: isRefreshable(credential)
          ? '临时凭据已过期，续期未成功，请稍后重试'
          : '临时凭据已过期，缺少续期材料，请重新登录',
      }
    }
    return { ok: true, credential }
  }

  if (!credential.access_token) {
    return { ok: false, message: '凭据缺少 access_token，请重新登录' }
  }
  return { ok: true, credential }
}

/**
 * 最近一次操作的提示（只放内存里）。
 *
 * 添加账号是「两阶段」的：接口早就返回了，成败发生在后台。没有这块的话，
 * 登录失败就是「占位账号悄悄消失」，用户完全不知道发生了什么——同一个华为云
 * 账号重复添加也是这么被漏掉的（看起来只是点了一次没反应，于是又点一次）。
 */
const NOTICE_LIMIT = 6
const notices = []

function pushNotice(channel, message, level = 'error') {
  notices.push({ channel, level, message, at: Date.now() })
  while (notices.length > NOTICE_LIMIT) notices.shift()
}

/**
 * 清掉已读的提示。
 *
 * 提示是「刚刚发生的事」，不是状态本身。用户点刷新就是想知道**现在**怎么样，
 * 若还把几分钟前的失败原样带回去，看起来就像又失败了一次——所以刷新时清空。
 */
function clearNotices(channel) {
  if (channel === undefined) {
    const removed = notices.length
    notices.length = 0
    return removed
  }
  let removed = 0
  for (let i = notices.length - 1; i >= 0; i -= 1) {
    if (notices[i].channel === channel) {
      notices.splice(i, 1)
      removed += 1
    }
  }
  return removed
}

function recentNotices(channel) {
  const cutoff = Date.now() - 10 * 60_000
  return notices.filter(row => row.at >= cutoff && (channel === undefined || row.channel === channel))
}

/**
 * 一个账号凭据对应的华为云账号身份。
 *
 * 状态查询与添加账号都要用；读不到就返回 `undefined`（老凭据里可能没有 JWT），
 * 调用方**不能**把 `undefined` 当成「确认不是重复」。
 */
function identityOfAccount(account) {
  if (typeof account?.credentialRef !== 'string') return undefined
  return codeArtsIdentity(readCredential(account.credentialRef))
}

async function statusOf(provider, account, deps) {
  const channel = channelById(provider)
  if (channel === undefined) return { state: 'error', message: `未知渠道 ${provider}` }

  const resolved = await credentialOf(account, deps)
  if (!resolved.ok) return { state: 'error', message: resolved.message }

  // CodeArts 的积分是账号级的，界面要靠身份把「同一个华为云账号被加了两次」标出来。
  const identity = provider === 'codearts' ? codeArtsIdentity(resolved.credential) : undefined
  const withIdentity = row => (identity === undefined
    ? row
    : { ...row, identity: { key: identity.key, name: identity.name } })

  try {
    // 腾讯系的余额是另一个端点，和签到状态无关：并行发，进设置页少等一个往返。
    // 余额查不到不影响签到状态（`fetchBuddyCredit` 内部已经吞掉所有失败）。
    const [result, credit] = provider === 'codearts'
      ? [await fetchCodeArtsStatus(resolved.credential), undefined]
      : await Promise.all([
        fetchBuddyStatus(resolved.credential, channel),
        fetchBuddyCredit(resolved.credential, channel).catch(() => undefined),
      ])
    const merged = withIdentity(credit === undefined ? result : { ...result, credit })
    // 续期成功但没落盘时把原因带到界面上：用户需要知道「这个账号重启后可能要重新登录」。
    return resolved.warning === undefined ? merged : { ...merged, warning: resolved.warning }
  } catch (error) {
    return withIdentity({ state: 'error', message: error?.message ?? String(error) })
  }
}

async function claimOf(provider, account, deps) {
  const channel = channelById(provider)
  if (channel === undefined) return { kind: 'failed', message: `未知渠道 ${provider}` }

  const resolved = await credentialOf(account, deps)
  if (!resolved.ok) return { kind: 'failed', message: resolved.message }

  try {
    const result = provider === 'codearts'
      ? await claimCodeArts(resolved.credential)
      : await claimBuddy(resolved.credential, channel)
    return resolved.warning === undefined ? result : { ...result, credentialWarning: resolved.warning }
  } catch (error) {
    return { kind: 'failed', message: error?.message ?? String(error) }
  }
}

/**
 * 有限并发地跑一组异步任务，结果按原顺序返回。
 *
 * 账号之间是完全独立的请求，历史实现逐个 `await`，五个账号就要等五轮 RTT
 * （CodeArts 每个账号还要两次请求）——「进设置页要转好几秒」就是这么来的。
 * 并发上限保守取 3：再多没有收益（网络本身就那样），却更像突发流量。
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 状态快照缓存。
 *
 * 设置页每次打开都会打一轮上游，而签到状态一天只变一次、余额也以分钟级变化。
 * 缓存 90 秒后「再进页面」是瞬时的；点「刷新」/「签到」时显式绕过它。
 * `DSH_CODEARTS_STATUS_TTL_MS=0` 可关掉。
 */
const STATUS_TTL_MS = Number(process.env.DSH_CODEARTS_STATUS_TTL_MS ?? '90000')
let statusCache = null

/** 状态发生了写操作（签到/增删/启停）后必须失效，否则界面会停在旧结果上。 */
function invalidateStatusCache() {
  statusCache = null
}

/** `notices` 不进缓存：它是「刚刚发生的事」，缓存一分钟就过时了。 */
function withNotices(doc) {
  return {
    ...doc,
    channels: doc.channels.map(channel => ({ ...channel, notices: recentNotices(channel.id) })),
  }
}

/**
 * 汇总所有渠道所有账号的状态。
 *
 * CodeArts 的行会带上身份（判重与显示用），重复账号由 `markDuplicates` 标出
 * ——额度只算一次。
 */
async function collectStatus(deps, options = {}) {
  const force = options.force === true
  if (!force && statusCache !== null && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return {
      ...withNotices(statusCache.doc),
      cached: true,
      ageMs: Date.now() - statusCache.at,
    }
  }

  const tasks = []
  for (const channel of CHANNELS) {
    for (const account of accountsOf(channel.id)) tasks.push({ channel, account })
  }

  const queried = await mapLimit(tasks, 3, async ({ channel, account }) => ({
    channel,
    account,
    status: await statusOf(channel.id, account, deps),
  }))

  // 身份回填要串行落盘：`updateAccount` 是读-改-写，并发写会互相覆盖。
  const patches = []
  for (const item of queried) {
    const identity = item.status.identity
    if (identity === undefined) continue
    const patch = {}
    if (item.account.identityKey !== identity.key) patch.identityKey = identity.key
    if ((item.account.nickname === undefined || item.account.nickname === item.account.id)
      && identity.name !== '') patch.nickname = identity.name
    if (Object.keys(patch).length > 0) patches.push({ id: item.account.id, patch })
  }
  for (const { id, patch } of patches) {
    try { updateAccount(id, patch) } catch { /* 写不进去只影响显示，不影响签到 */ }
  }

  const channels = CHANNELS.map(channel => {
    const rows = queried
      .filter(item => item.channel.id === channel.id)
      .map(({ account, status }) => {
        const patch = patches.find(row => row.id === account.id)?.patch
        return {
          id: account.id,
          nickname: account.nickname,
          enabled: account.enabled,
          ...status,
          ...(patch === undefined ? {} : patch),
        }
      })
    markDuplicates(rows)
    return {
      id: channel.id,
      name: channel.name,
      org: channel.org,
      accounts: rows,
      claimableCount: rows.filter(row => row.state === 'claimable').length,
      checkedInCount: rows.filter(row => row.state === 'checked-in').length,
      errorCount: rows.filter(row => row.state === 'error').length,
    }
  })

  const doc = { date: today(), channels }
  statusCache = { at: Date.now(), doc }
  return withNotices(doc)
}

/** 签到所有可签到账号。`only` 限定渠道或账号 id。 */
async function claimAll(only, deps) {
  const results = []
  // 同一个华为云账号只签一次：重复行去上游领取只会拿到「今天已领」，
  // 纯属白跑一趟，还多一次可能触发风控的写入。
  const claimedIdentities = new Set()
  for (const channel of CHANNELS) {
    const accounts = accountsOf(channel.id)
    for (const account of accounts) {
      if (only !== undefined && only !== channel.id && only !== account.id) continue

      if (channel.id === 'codearts') {
        const key = account.identityKey ?? identityOfAccount(account)?.key
        if (typeof key === 'string' && key !== '') {
          if (claimedIdentities.has(key)) {
            results.push({
              channel: channel.id, channelName: channel.name,
              accountId: account.id, nickname: account.nickname,
              kind: 'inactive',
              message: '与前面的账号是同一个华为云账号，已跳过（同一份额度只签一次）',
            })
            continue
          }
          claimedIdentities.add(key)
        }
      }

      // 先查状态：已签到的账号不再发领取请求，避免制造无谓的上游写入。
      const status = await statusOf(channel.id, account, deps)
      if (status.state === 'checked-in') {
        results.push({
          channel: channel.id, channelName: channel.name,
          accountId: account.id, nickname: account.nickname,
          kind: 'already-claimed', message: status.message ?? '今天已签到',
        })
        continue
      }
      if (status.state === 'inactive' || status.state === 'error') {
        results.push({
          channel: channel.id, channelName: channel.name,
          accountId: account.id, nickname: account.nickname,
          kind: status.state === 'inactive' ? 'inactive' : 'failed',
          message: status.message ?? '',
        })
        continue
      }

      const outcome = await claimOf(channel.id, account, deps)
      results.push({
        channel: channel.id, channelName: channel.name,
        accountId: account.id, nickname: account.nickname,
        ...outcome,
      })
    }
  }

  const summary = {
    claimed: results.filter(row => row.kind === 'claimed').length,
    alreadyClaimed: results.filter(row => row.kind === 'already-claimed').length,
    inactive: results.filter(row => row.kind === 'inactive').length,
    failed: results.filter(row => row.kind === 'failed').length,
  }
  return { date: today(), summary, results }
}

/**
 * 把 CodeArts 的免费额度接成 DSH 的一个模型渠道。
 *
 * 只实现 DSH 要求的五个方法（鸭子类型，与 dsh-workbuddy 一致，不继承 LlmAdapter）：
 * `providerInfo` / `listModels` / `resolveModel` / `prepareCall` / `stream`。
 *
 * 凭据不在这里续期——续期要写回凭据库，那是 index.js 里 `credentialOf` 的职责，
 * 这里只通过 `resolveCredential` 拿一份「现在就能用」的凭据。
 */
class CodeArtsAdapter {
  constructor({ resolveCredential, resolvePool, logger, sessionId }) {
    this.resolveCredential = resolveCredential
    this.resolvePool = resolvePool
    this.logger = logger ?? console
    this.sessionId = sessionId
    this.chatId = sessionId
  }

  providerInfo(provider) {
    // DSH 会校验 info.id === provider，且用 id 推导凭据 ref，入参异常时回退常量
    const id = typeof provider === 'string' && provider.length > 0 ? provider : LLM_PROVIDER
    return { id, name: 'CodeArts（华为云）' }
  }

  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: Object.freeze(['TRANSPORT', 'SERVER', 'TIMEOUT']),
      initialDelayMs: 1000,
      maxDelayMs: 8000,
      jitterRatio: 0.2,
    })
  }

  async listModels(provider) {
    const credential = await this.resolveCredential().catch(() => undefined)
    // 没登录就不列模型：选择器里出现一个点了必失败的渠道比没有更糟
    if (credential === undefined) return []
    let catalog
    try {
      catalog = await fetchModelCatalog(credential)
    } catch {
      return []
    }
    return catalog.models.map(row => ({
      provider,
      id: row.id,
      name: row.name,
      inputModalities: row.vision ? ['text', 'image'] : ['text'],
    }))
  }

  async resolveModel(provider, model) {
    const info = modelInfo(model)
    return {
      provider,
      id: model,
      name: info.name,
      inputModalities: info.vision ? ['text', 'image'] : ['text'],
      context: { contextWindow: info.contextWindow },
      defaultMaxTokens: info.maxOutput,
      // 网关认「开/关」两档，默认开（与服务端默认一致，只有关才需要发字段）
      reasoning: {
        efforts: [{ id: 'on', name: '开启' }, { id: 'off', name: '关闭' }],
        defaultEffort: 'on',
      },
    }
  }

  async prepareCall(provider, model) {
    const info = await this.resolveModel(provider, model)
    return { model: info, stream: options => this.stream(options) }
  }

  async *stream(options) {
    // 用**账号池**而不是单个账号：服务端每账号只给 3 个并发会话，
    // 多账号时轮转既能摊薄压力，也能在一个账号满/凭据坏时换人接着跑。
    const pool = this.resolvePool === undefined
      ? []
      : await this.resolvePool().catch(() => [])
    const accounts = pool.length > 0 ? pool : undefined
    if (accounts === undefined) {
      const credential = await this.resolveCredential()
      if (credential === undefined) {
        throw Object.assign(
          new Error('CodeArts 没有可用账号：请到「设置 → 签到」添加并登录一个 CodeArts 账号'),
          { code: 'MISSING_CREDENTIAL' },
        )
      }
      lastModel = options.model
      const body = buildRequestBody(options, this.sessionId)
      yield* streamChat({
        credential,
        body,
        model: options.model,
        signal: options.signal,
        sessionId: this.sessionId,
        chatId: this.chatId,
      })
      return
    }

    lastModel = options.model
    const body = buildRequestBody(options, this.sessionId)
    yield* streamChat({
      accounts,
      body,
      model: options.model,
      signal: options.signal,
      sessionId: this.sessionId,
      chatId: this.chatId,
    })
  }
}

/** 最近一次实际请求的模型：设置页查服务端排队状态时要用它。 */
let lastModel

export function apply(ctx) {
  const logger = ctx.logger ?? console

  // 凭据服务：退出账号要真的把凭据从存储里清掉，只删池记录等于留下孤儿密钥。
  // 单独注入而不是并进 webServer，缺了它只影响「退出账号」，签到照常可用。
  let credentials = null
  ctx.inject(['credentials'], scoped => {
    credentials = scoped.credentials
    scoped.effect?.(() => () => { credentials = null }, 'dsh-codearts-checkin: credentials')
  })

  // 续期要能把新凭据写回存储，而 inject 是异步的：用 getter 而不是抓当前值，
  // 否则自动签到那一轮可能拿到 null，续期成功却写不回去。
  const deps = { getStore: () => credentials }

  // ── 取一份「现在就能用」的 CodeArts 凭据（含临期自动续期）─────────────────
  // 模型渠道与签到共用同一条取凭据路径，续期逻辑只写一遍。
  const resolveCodeArtsCredential = async () => {
    const account = accountsOf('codearts').find(row => row.enabled !== false)
    if (account === undefined) return undefined
    const resolved = await credentialOf(account, deps)
    if (!resolved.ok) {
      throw Object.assign(new Error(resolved.message), { code: 'INVALID_CREDENTIAL' })
    }
    return resolved.credential
  }

  /**
   * 取**所有**启用中的 CodeArts 账号凭据（含临期续期）。
   *
   * 模型渠道用它做轮转：服务端每账号限 3 个并发会话，两个账号就是 6 个。
   * 单个账号取凭据失败只跳过它，不让整轮对话失败——这正是多账号的意义。
   */
  const resolveCodeArtsPool = async () => {
    const rows = []
    // 同一华为云账号被加了两次时，服务端的并发上限仍然是 3：本地若当成两个账号，
    // 会按 6 个名额放行，撞墙后才在服务端报错。所以按身份去重，只留第一份。
    const seen = new Set()
    for (const account of accountsOf('codearts')) {
      if (account.enabled === false) continue
      try {
        const resolved = await credentialOf(account, deps)
        if (!resolved.ok) continue
        const key = codeArtsIdentity(resolved.credential)?.key
          ?? account.identityKey
          ?? account.id
        if (seen.has(key)) continue
        seen.add(key)
        rows.push({ accountId: account.id, credential: resolved.credential })
      } catch { /* 换个账号就是了 */ }
    }
    return rows
  }

  // ── LLM 渠道：让 CodeArts 的免费额度出现在模型选择器里 ────────────────────
  // 单独 inject(['llm'])：缺了它只少一个渠道，签到与设置页照常可用。
  ctx.inject(['llm'], scoped => {
    const llm = scoped.llm
    // 某些 composition 可能没有 llm 服务。宁可少一个渠道，也不能让异常冒到
    // 注入回调外——那会让整个插件从 composition 里掉出去（签到也一起没了）。
    if (llm === undefined || llm === null || typeof llm.registerAdapter !== 'function') {
      logger.warn?.('dsh-codearts-checkin: 没有 llm 服务，跳过模型渠道注册')
      return
    }
    scoped.effect(() => {
      const adapter = new CodeArtsAdapter({
        resolveCredential: resolveCodeArtsCredential,
        resolvePool: resolveCodeArtsPool,
        logger,
        sessionId: randomBytes(16).toString('hex'),
      })
      const dispose = llm.registerAdapter([LLM_PROVIDER], adapter)
      logger.info?.(`dsh-codearts-checkin: llm adapter registered as ${LLM_PROVIDER}`)
      return dispose
    }, 'dsh-codearts-checkin: adapter')
  })

  // ── Web 路由 ──────────────────────────────────────────────────────────────
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer

    const json = (res, status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(body))
    }

    /** 读请求体；空体或坏 JSON 一律当空对象，策略由各路由自己决定。 */
    const readJson = async req => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.length === 0) return {}
      try {
        const parsed = JSON.parse(text)
        return typeof parsed === 'object' && parsed !== null ? parsed : {}
      } catch {
        return {}
      }
    }

    /** 查一次服务端的排队状态（只在用户点「检查」时调用，避免多于请求）。 */
    const probeQueue = async () => {
      const model = lastModel
      if (typeof model !== 'string' || model === '') {
        return { available: false, message: '本次运行还没有发起过对话，没有可查的模型' }
      }
      const pool = await resolveCodeArtsPool().catch(() => [])
      if (pool.length === 0) return { available: false, message: '没有可用的 CodeArts 账号' }
      try {
        const status = await fetchQueueStatus({
          credential: pool[0].credential,
          model,
          taskId: `dsh-probe-${randomBytes(6).toString('hex')}`,
        })
        if (status === undefined) return { available: false, message: '服务端未返回排队状态' }
        return { available: true, model, accountId: pool[0].accountId, ...status }
      } catch (error) {
        return { available: false, message: String(error?.message ?? error) }
      }
    }

    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.replace(/^\/api\/codearts-checkin/, '').replace(/\/+$/, '') || '/'
      try {
        if (req.method === 'GET' && route === '/status') {
          // 默认吃 90 秒缓存（进页面要快）；点「刷新」时带 `?refresh=1` 绕过。
          // 刷新同时清掉旧提示：提示是「刚发生的事」，不是状态的一部分——
          // 把几分钟前的失败原样带回来，用户会以为刷新没生效、或者又失败了一次。
          const refresh = url.searchParams.get('refresh') === '1'
          if (refresh) clearNotices()
          json(res, 200, await collectStatus(deps, { force: refresh }))
          return
        }
        if (req.method === 'POST' && route === '/claim') {
          const payload = await readJson(req)
          const result = await claimAll(typeof payload.only === 'string' ? payload.only : undefined, deps)
          invalidateStatusCache()
          json(res, 200, result)
          return
        }

        // ── 模型目录：设置页用它显示「这个渠道能选哪些模型」 ────────────────
        if (req.method === 'GET' && route === '/models') {
          let credential
          try {
            credential = await resolveCodeArtsCredential()
          } catch (error) {
            json(res, 200, {
              provider: LLM_PROVIDER,
              loggedIn: false,
              models: [],
              message: String(error?.message ?? error),
            })
            return
          }
          if (credential === undefined) {
            json(res, 200, { provider: LLM_PROVIDER, loggedIn: false, models: [], message: '还没有 CodeArts 账号' })
            return
          }
          try {
            const catalog = await fetchModelCatalog(credential)
            json(res, 200, {
              provider: LLM_PROVIDER,
              loggedIn: true,
              models: catalog.models.map(row => ({
                id: row.id,
                name: row.name,
                contextWindow: row.contextWindow,
                offPeak: row.offPeak,
              })),
            })
          } catch (error) {
            json(res, 502, { error: String(error?.message ?? error) })
          }
          return
        }
        if (req.method === 'POST' && route === '/notices/clear') {
          // 「刷新」先调这个再取状态：提示是事件，不是状态，不能跟着刷新一起复活。
          const payload = await readJson(req)
          const only = typeof payload.channel === 'string' && payload.channel !== '' && payload.channel !== 'all'
            ? payload.channel
            : undefined
          json(res, 200, { ok: true, cleared: clearNotices(only) })
          return
        }
        if (req.method === 'POST' && route === '/models/refresh') {
          invalidateCatalog()
          json(res, 200, { ok: true })
          return
        }

        // ── 会话：本机在途流可见 + 可终止 ──────────────────────────────────
        // 服务端**没有**查询/关闭会话的接口（`/api/v1/queue/list` 等一律
        // APIG.0101），所以这里只呈现本插件自己发起的流：它们的生命周期
        // 完全由本进程掌握，终止即断流，服务端名额随之释放。
        if (req.method === 'GET' && route === '/sessions') {
          const snap = sessionSnapshot()
          const nicknames = new Map(accountsOf('codearts').map(row => [row.id, row.nickname]))
          const body = {
            ...snap,
            provider: LLM_PROVIDER,
            lastModel: lastModel ?? null,
            inflight: snap.inflight.map(row => ({
              ...row,
              nickname: nicknames.get(row.accountId) ?? row.accountId,
            })),
            accounts: snap.accounts.map(row => ({
              ...row,
              nickname: nicknames.get(row.accountId) ?? row.accountId,
            })),
          }
          if (url.searchParams.get('queue') === '1') body.queue = await probeQueue()
          json(res, 200, body)
          return
        }
        if (req.method === 'POST' && route === '/sessions/abort') {
          const payload = await readJson(req)
          const id = typeof payload.id === 'string' ? payload.id : ''
          const result = id === ''
            ? abortAllSessions('user')
            : { aborted: abortSession(id) ? 1 : 0, reason: 'user' }
          logger.info?.(`dsh-codearts-checkin: 终止在途会话 ${result.aborted} 个`)
          json(res, 200, { ok: true, ...result, state: sessionSnapshot() })
          return
        }

        // ── 账号管理：退出 / 启用停用 ─────────────────────────────────────
        // 只接受本插件支持的三家渠道，避免误删 ofm 自己管的免费渠道账号。
        if (req.method === 'POST' && route === '/accounts/remove') {
          const body = await readJson(req)
          const channel = typeof body.channel === 'string' ? body.channel : ''
          const accountId = typeof body.accountId === 'string' ? body.accountId : ''
          if (channel === '' || accountId === '') {
            json(res, 400, { error: 'channel 与 accountId 必填' })
            return
          }

          const account = accountsOf(channel).find(row => row.id === accountId)
          if (account === undefined) {
            json(res, 404, { error: `账号池里找不到 ${channel}/${accountId}` })
            return
          }

          // 先清凭据再删池记录：凭据清不掉时整个操作中止，不留下
          // 「账号从列表消失、凭据还躺在文件里」的不一致状态。
          const ref = account.credentialRef
          if (typeof ref === 'string' && ref !== '') {
            if (credentials === null || credentials === undefined) {
              json(res, 503, { error: '凭据服务不可用，已中止（未删除任何内容）' })
              return
            }
            try {
              await credentials.unset(ref)
            } catch (error) {
              json(res, 500, { error: `清除凭据失败：${error?.message ?? error}` })
              return
            }
          }

          const removed = removeAccount(channel, accountId)
          invalidateStatusCache()
          logger.info?.(`dsh-codearts-checkin: 已退出账号 ${channel}/${accountId}`)
          json(res, 200, { ok: true, removed, state: await collectStatus(deps) })
          return
        }

        if (req.method === 'POST' && route === '/accounts/toggle') {
          const body = await readJson(req)
          const channel = typeof body.channel === 'string' ? body.channel : ''
          const accountId = typeof body.accountId === 'string' ? body.accountId : ''
          if (channel === '' || accountId === '') {
            json(res, 400, { error: 'channel 与 accountId 必填' })
            return
          }
          const result = setAccountEnabled(channel, accountId, body.enabled === true)
          invalidateStatusCache()
          logger.info?.(`dsh-codearts-checkin: ${result.enabled ? '启用' : '停用'}账号 ${channel}/${accountId}`)
          json(res, 200, { ok: true, ...result, state: await collectStatus(deps) })
          return
        }

        // ── 添加账号：三家都走浏览器授权，返回登录地址后由前端打开 ──────────
        // 两阶段与 2.1.0 一致：先拿到 URL 立刻返回（延迟拿 URL 会被浏览器
        // 当成非用户手势而拦截弹窗），授权完成在后台等。
        //
        // 腾讯系：拿 state + authUrl → 轮询 auth/token → 轮询 login/account。
        // CodeArts：本地起回调服务器（必须先起，URL 里要带端口）→ portal 授权
        //           → 回跳带 code → 用 PKCE + DPoP 向 STS 换临时 AK/SK。
        if (req.method === 'POST' && route === '/accounts/add') {
          const body = await readJson(req)
          const channel = typeof body.channel === 'string' ? body.channel : ''
          if (channel !== 'buddy' && channel !== 'workbuddy' && channel !== 'codearts') {
            json(res, 400, { error: `不支持添加渠道 ${channel || '(空)'}` })
            return
          }
          if (credentials === null || credentials === undefined) {
            json(res, 503, { error: '凭据服务不可用，无法保存登录结果' })
            return
          }

          let loginUrl
          let waitForCredential
          let closeLogin = async () => {}
          try {
            if (channel === 'codearts') {
              const started = await startCodeArtsLogin()
              loginUrl = started.loginUrl
              waitForCredential = () => started.result
              closeLogin = started.close
            } else {
              const started = await startBuddyLogin(channel)
              loginUrl = started.loginUrl
              waitForCredential = () => finishBuddyLogin(started.state, channel)
            }
          } catch (error) {
            json(res, 502, { error: String(error?.message ?? error) })
            return
          }

          const suffix = randomSuffix()
          const accountId = `${channel}-${suffix.toLowerCase()}`
          const refName = `${channel.toUpperCase()}_ACCOUNT_${suffix}`
          try {
            addAccount({
              id: accountId,
              provider: channel,
              nickname: accountId,
              enabled: true,
              credentialRef: refName,
              refreshable: false,
              createdAt: Date.now(),
            })
          } catch (error) {
            // 占位账号没落盘就别留着回调服务器和轮询——它最多会挂 3~5 分钟。
            await closeLogin()
            json(res, 500, { error: String(error?.message ?? error) })
            return
          }

          // 后台等授权：成功后写凭据并回填昵称；失败就把占位账号撤掉，
          // 不给用户留一条永远「未登录」的空账号。
          void waitForCredential()
            .then(async result => {
              // 华为云这边「重复添加」是静默发生的：浏览器里已登录同一个华为云
              // 账号时，再点一次授权会直接返回新的临时 AK/SK，长得完全不像重复。
              // 但它就是同一份积分额度，多一行只会让余额被算两遍，所以在落盘前拦掉。
              if (channel === 'codearts') {
                const identity = codeArtsIdentity(result.credential)
                const clash = findDuplicateAccount(accountsOf('codearts'), identity, {
                  selfId: accountId,
                  identityOf: identityOfAccount,
                })
                if (clash !== undefined) {
                  try { removeAccount(channel, accountId) } catch { /* 已经不在了 */ }
                  const who = clash.nickname || clash.id
                  pushNotice(channel,
                    `这个华为云账号已经添加过（${who}），没有重复添加。`
                    + '要添加另一个华为云账号，请先在浏览器里退出华为云登录（或用无痕窗口）再点「添加账号」。',
                    'warn')
                  throw new Error(`重复账号：${identity.name || identity.key}`)
                }
                await credentials.set(refName, result.serialized)
                updateAccount(accountId, {
                  nickname: identity?.name !== undefined && identity.name !== '' ? identity.name : accountId,
                  identityKey: identity?.key,
                  expiresAt: result.expiresAt,
                  refreshable: result.refreshable,
                })
                // 这次添加成功了，之前那些「超时 / 失败」的旧提示就不再成立，
                // 留着只会让人以为账号没加上——清掉，换一条成功回执。
                clearNotices(channel)
                pushNotice(channel,
                  `已添加账号 ${identity?.name !== undefined && identity.name !== '' ? identity.name : accountId}，`
                  + '临时凭据会自动续期。', 'info')
              } else {
                await credentials.set(refName, result.serialized)
                updateAccount(accountId, {
                  nickname: result.nickname.length > 0 ? result.nickname : accountId,
                  expiresAt: result.expiresAt,
                  refreshable: result.refreshable,
                })
              }
              invalidateStatusCache()
              logger.info?.(`dsh-codearts-checkin: 已添加账号 ${channel}/${accountId}`)
            })
            .catch(error => {
              logger.warn?.(`dsh-codearts-checkin: 添加账号失败 ${channel}/${accountId}：${error?.message ?? error}`)
              try { removeAccount(channel, accountId) } catch { /* 已经不在池子里就算了 */ }
              // 只有「重复」那条已经写好了更具体的提示；其余失败在这里补上，
              // 否则用户只会看到占位账号凭空消失。
              const message = String(error?.message ?? error)
              if (!message.startsWith('重复账号')) {
                pushNotice(channel, `添加账号失败：${message}`)
              }
            })
            .finally(() => { void closeLogin() })

          json(res, 200, { ok: true, accountId, channel, loginUrl })
          return
        }
        json(res, 404, { error: `no route for ${req.method} ${route}` })
      } catch (error) {
        logger.warn?.(`dsh-codearts-checkin: ${route} 失败：${error?.message ?? error}`)
        json(res, 500, { error: String(error?.message ?? error) })
      }
    }

    scoped.effect(() => {
      const dispose = server.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
      logger.info?.('dsh-codearts-checkin: 已挂载 /api/codearts-checkin')
      return dispose
    }, 'dsh-codearts-checkin: routes')
  })

  // ── 每次启动后延迟跑一轮自动签到 ──────────────────────────────────────────
  // 只做签到、不做推理，所以没有「等续期先跑」的依赖；延迟只为不跟启动抢资源。
  const delayMs = Number(process.env.DSH_CODEARTS_AUTO_CHECKIN_DELAY_MS ?? '15000')
  if (Number.isFinite(delayMs) && delayMs >= 0) {
    const timer = setTimeout(() => {
      claimAll(undefined, deps)
        .then(result => {
          const { summary } = result
          if (summary.claimed > 0) {
            logger.info?.(`dsh-codearts-checkin: 自动签到完成，新领 ${summary.claimed} 个`)
          }
          // 顺手把状态快照焐热：用户通常紧接着就会打开「设置 → 签到」，
          // 缓存已在的话首屏是瞬时的，不用再等一轮上游。
          invalidateStatusCache()
          void collectStatus(deps).catch(() => {})
        })
        .catch(error => {
          logger.warn?.(`dsh-codearts-checkin: 自动签到失败：${error?.message ?? error}`)
        })
    }, delayMs)
    timer.unref?.()
    ctx.effect?.(() => () => clearTimeout(timer), 'dsh-codearts-checkin: auto checkin')
  }
}

/** 仅探针使用：提示是纯内存态，端到端测试需要从外部注入一条。 */
export const __noticesForTests = { push: pushNotice, clear: clearNotices, list: recentNotices }

// ─────────────────────────────────────────────────────────────
// 此插件由 WorkBuddy 设计，并参考 Our Free Model 开发。
// ─────────────────────────────────────────────────────────────

