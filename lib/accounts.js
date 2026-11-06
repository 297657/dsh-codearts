/**
 * 账号池的写操作（退出账号 / 启用停用）。
 *
 * 只碰本插件支持的三家渠道（`buddy` / `workbuddy` / `codearts`）：
 * 账号池里还有 qoder、trae、zcode 这些免费渠道的账号，它们由 ofm 自己管理，
 * 本插件不提供入口，也不允许从这里删——越界操作会让 ofm 的渠道失效。
 *
 * 写入用「临时文件 + rename」：state.json 是 ofm 与 DSH 共用的文件，
 * 直接覆写一旦中途失败就会留下半个 JSON，账号池整个读不出来。
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { statePath, CHANNELS } from './credentials.js'

const SUPPORTED = new Set(CHANNELS.map(channel => channel.id))

export function supportedChannels() {
  return [...SUPPORTED]
}

function readState() {
  const text = readFileSync(statePath(), 'utf8')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('账号池文件不是合法 JSON，已中止（不做任何写入）')
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.accounts)) {
    throw new Error('账号池格式异常（缺少 accounts 数组），已中止')
  }
  return parsed
}

function writeState(state) {
  const path = statePath()
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, path)
}

function locate(state, channelId, accountId) {
  if (!SUPPORTED.has(channelId)) throw new Error(`不支持管理渠道 ${channelId}`)
  const index = state.accounts.findIndex(row => row.id === accountId && row.provider === channelId)
  if (index < 0) throw new Error(`账号池里找不到 ${channelId}/${accountId}`)
  return index
}

/**
 * 从账号池移除一个账号，并返回它的凭据引用（由调用方负责清除凭据）。
 *
 * 先读后写、只有校验全部通过才落盘：任何一步失败都不会留下半改的状态。
 */
export function removeAccount(channelId, accountId) {
  const state = readState()
  const index = locate(state, channelId, accountId)
  const [removed] = state.accounts.splice(index, 1)
  writeState(state)
  return {
    accountId: removed.id,
    nickname: removed.nickname,
    credentialRef: typeof removed.credentialRef === 'string' ? removed.credentialRef : undefined,
    remaining: state.accounts.length,
  }
}

/** 启用/停用一个账号。停用不删凭据，随时可以再打开。 */
export function setAccountEnabled(channelId, accountId, enabled) {
  const state = readState()
  const index = locate(state, channelId, accountId)
  state.accounts[index] = { ...state.accounts[index], enabled: enabled === true }
  writeState(state)
  return { accountId, enabled: enabled === true }
}

/** 先落一条占位账号：登录还没完成时它就在列表里，前端能立刻看到进度。 */
export function addAccount(entry) {
  if (!SUPPORTED.has(entry.provider)) throw new Error(`不支持添加渠道 ${entry.provider}`)
  const state = readState()
  if (state.accounts.some(row => row.id === entry.id)) throw new Error(`账号 ${entry.id} 已存在`)
  state.accounts.push(entry)
  writeState(state)
  return entry
}

/** 登录完成后回填昵称、过期时间等。找不到（比如用户中途删了）返回 false。 */
export function updateAccount(accountId, patch) {
  const state = readState()
  const index = state.accounts.findIndex(row => row.id === accountId)
  if (index < 0) return false
  state.accounts[index] = { ...state.accounts[index], ...patch }
  writeState(state)
  return true
}
