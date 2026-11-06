/**
 * 本机会话闸门与在途登记。
 *
 * ## 为什么需要它
 *
 * CodeArts 对**每个账号**只允许 3 个并发会话，超了直接回
 * `TM.00001041 并发会话数已达上限(3个)`。DSH 一侧完全可能同时发起多个
 * 流（并行子任务、重试、用户连发两条消息），这些请求打同一个账号时
 * 必然撞墙——实测两条消息同时发出去就是两条「处理失败」。
 *
 * 服务端**没有**任何「列出会话 / 关闭会话」的端点（`/api/v1/queue/list`、
 * `/api/v1/chat/sessions` 等在此网关上一律 `APIG.0101 接口不存在`，见
 * `wb-diag/probe-codearts-queue.mjs`）。所以能做的只有两件事：
 *
 * 1. **别自己撞上去**：按账号串行排队，本地就把并发压在 3 以内；
 * 2. **看得见、关得掉**：登记每一路在途流，让设置页能显示「正在跑什么、
 *    跑了多久」，并支持一键终止——终止即关闭 TCP 流，服务端名额立刻释放。
 *
 * 这两件事都在本进程内完成，不依赖任何服务端能力。
 */

/** 服务端上限是 3；默认就用 3，别自己加码。 */
const DEFAULT_LIMIT = 3
const DEFAULT_WAIT_MS = 120_000

function limitOf() {
  const raw = Number(process.env.DSH_CODEARTS_MAX_CONCURRENCY ?? DEFAULT_LIMIT)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_LIMIT
}

/** accountId -> { active: number, queue: entry[] } */
const gates = new Map()
/** id -> { id, accountId, model, phase, startedAt, controller } */
const inflight = new Map()
/** accountId -> { until: number, reason: string } */
const cooldowns = new Map()

function gateOf(accountId) {
  let gate = gates.get(accountId)
  if (gate === undefined) {
    gate = { active: 0, queue: [] }
    gates.set(accountId, gate)
  }
  return gate
}

function abortedError() {
  return Object.assign(new Error('codearts: 请求已取消'), { code: 'ABORTED' })
}

function queueTimeoutError(waitMs) {
  return Object.assign(
    new Error(`codearts: 本机排队超过 ${Math.round(waitMs / 1000)} 秒仍未拿到名额（并发上限 ${limitOf()}）`),
    { code: 'QUEUE_TIMEOUT' },
  )
}

function makeRelease(gate) {
  let released = false
  return () => {
    if (released) return
    released = true
    gate.active = Math.max(0, gate.active - 1)
    pump(gate)
  }
}

/** 名额空出来时按 FIFO 交给下一个等待者。 */
function pump(gate) {
  const limit = limitOf()
  while (gate.active < limit && gate.queue.length > 0) {
    const next = gate.queue.shift()
    clearTimeout(next.timer)
    next.signal?.removeEventListener?.('abort', next.onAbort)
    gate.active += 1
    next.resolve(makeRelease(gate))
  }
}

/**
 * 占用一个账号名额。返回 `release()`。
 *
 * 超限时**排队等待**而不是立刻失败——用户看到的是「思考中」而不是一条
 * 无从下手的错误。等待期间响应 `signal` 取消，取消后不再占名额。
 */
export function acquireSlot(accountId, { signal, waitMs = DEFAULT_WAIT_MS } = {}) {
  if (signal?.aborted === true) return Promise.reject(abortedError())

  const gate = gateOf(accountId)
  if (gate.active < limitOf()) {
    gate.active += 1
    return Promise.resolve(makeRelease(gate))
  }

  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, signal }
    const forget = () => {
      clearTimeout(entry.timer)
      signal?.removeEventListener?.('abort', entry.onAbort)
      const at = gate.queue.indexOf(entry)
      if (at >= 0) gate.queue.splice(at, 1)
    }
    entry.timer = setTimeout(() => { forget(); reject(queueTimeoutError(waitMs)) }, waitMs)
    entry.onAbort = () => { forget(); reject(abortedError()) }
    signal?.addEventListener?.('abort', entry.onAbort, { once: true })
    gate.queue.push(entry)
  })
}

//
// ── 在途会话登记 ─────────────────────────────────────────────────────────────
//

/** 登记一路在途流；`done()` 必须放在 finally 里。 */
export function registerSession({ accountId, model, controller }) {
  const id = `${accountId}-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`
  inflight.set(id, { id, accountId, model, phase: 'connecting', startedAt: Date.now(), controller })
  return {
    id,
    setPhase(phase) {
      const row = inflight.get(id)
      if (row !== undefined) row.phase = phase
    },
    done() { inflight.delete(id) },
  }
}

export function inflightOf() {
  return [...inflight.values()].map(row => ({
    id: row.id,
    accountId: row.accountId,
    model: row.model,
    phase: row.phase,
    elapsedMs: Date.now() - row.startedAt,
  }))
}

/**
 * 终止本机在途流（全部或指定一条）。
 *
 * 只是 `controller.abort()`：fetch 被中断 → 连接关闭 → 服务端把会话判为
 * 结束并释放名额。服务端没有关闭接口，这是唯一「用户能主动关会话」的手段。
 */
export function abortAllSessions(reason = 'user') {
  const rows = [...inflight.values()]
  for (const row of rows) {
    // 先改阶段再 abort：被掐断的流要等消费方下一次 next() 才会真正收尾，
    // 界面据此显示「已终止」而不是「输出中」。
    row.phase = 'aborting'
    try { row.controller?.abort() } catch { /* 已结束 */ }
  }
  return { aborted: rows.length, reason }
}

export function abortSession(id) {
  const row = inflight.get(id)
  if (row === undefined) return false
  row.phase = 'aborting'
  try { row.controller?.abort() } catch { /* ignore */ }
  return true
}

//
// ── 冷却 ────────────────────────────────────────────────────────────────────
//

/** 撞到并发上限后给账号打一个冷却，期间优先换别的账号、不硬撞。 */
export function setCooldown(accountId, ms, reason) {
  cooldowns.set(accountId, { until: Date.now() + ms, reason })
}

export function cooldownOf(accountId) {
  const row = cooldowns.get(accountId)
  if (row === undefined) return undefined
  if (row.until <= Date.now()) { cooldowns.delete(accountId); return undefined }
  return { remainingMs: row.until - Date.now(), reason: row.reason }
}

export function snapshot() {
  return {
    limit: limitOf(),
    inflight: inflightOf(),
    accounts: [...gates.entries()].map(([accountId, gate]) => ({
      accountId,
      active: gate.active,
      queued: gate.queue.length,
      cooldown: cooldownOf(accountId),
    })),
  }
}

/** 仅供测试：清空全部内存状态。 */
export function resetForTests() {
  gates.clear()
  inflight.clear()
  cooldowns.clear()
}

export const SESSION_LIMITS = { DEFAULT_LIMIT, DEFAULT_WAIT_MS }
