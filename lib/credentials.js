/**
 * 读取宿主凭据库（`~/.dsh/.credentials.yaml`）与频道账号池（`~/.dsh/channel-pack/state.json`）。
 *
 * 为什么直接读文件而不是用 `ctx.credentials`：本插件只做签到这一件只读操作，
 * 走 Service 需要 `ctx.inject(['credentials'])` 并处理异步解析/描述两条路径，
 * 而凭据本身就是本机 YAML 明文。读文件让插件在 credentials 服务缺席时
 * 依然可用，也让「签到失败是因为凭据过期」这类原因能直接呈现给用户。
 *
 * ⚠️ 凭据只在本进程内使用，绝不写日志、绝不回传给浏览器。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function credentialsPath() {
  return join(dshHome(), '.credentials.yaml')
}

export function statePath() {
  return join(dshHome(), 'channel-pack', 'state.json')
}

/**
 * 解析 YAML 的 single-quoted 标量。
 *
 * 凭据文件是逐条 `KEY: '<json>'` 的形态，JSON 内部含换行（如 `scope` 字段），
 * YAML 会把单个换行折叠成空格。手写解析只覆盖这一种形态，不追求通用性：
 * 引入 YAML 依赖只为读六个字段不值得。
 */
function yamlSingleQuoted(text, key) {
  const marker = `\n  ${key}: '`
  const start = text.indexOf(marker)
  if (start < 0) return undefined
  let i = start + marker.length
  let out = ''
  for (; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'") {
      if (text[i + 1] === "'") { out += "'"; i++; continue }
      break
    }
    out += ch
  }
  return out.replace(/[ \t]*\r?\n[ \t]*/g, ' ')
}

/** 读取单条凭据并解析为对象；不存在或无法解析时返回 undefined。 */
export function readCredential(refName) {
  let text
  try {
    text = readFileSync(credentialsPath(), 'utf8')
  } catch {
    return undefined
  }
  const raw = yamlSingleQuoted(text, refName)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * 频道账号池（`channel-pack/state.json`）。
 *
 * 只用来把 `credentialRef` 映射到 provider / nickname，好让界面按渠道分组展示。
 * 读不到时退化为「按凭据名前缀猜 provider」，不影响签到本身。
 */
export function readAccountPool() {
  try {
    const doc = JSON.parse(readFileSync(statePath(), 'utf8'))
    return Array.isArray(doc?.accounts) ? doc.accounts : []
  } catch {
    return []
  }
}

/**
 * 本插件支持的渠道。
 *
 * - `buddy`（CodeBuddy 中国版，copilot.tencent.com）——每日签到；
 * - `workbuddy`（WorkBuddy，站点取自凭据 domain）——与 CodeBuddy 同一套端点，
 *   但**是否存在签到活动由服务端决定**：实测 `.ai` 站点账号返回 `active:false`，
 *   此时状态如实报 inactive，不发领取请求；
 * - `codearts`（华为云 CodeArts）——`/v1/ops/delivery` 的 USER_LOGIN 活动。
 *
 * 三个渠道都按 `provider` 从账号池筛选，账号没登录就自然跳过。
 */
export const CHANNELS = [
  {
    id: 'buddy',
    name: 'CodeBuddy',
    org: '腾讯',
    endpoint: 'https://copilot.tencent.com',
    apiDomain: 'copilot.tencent.com',
    productCode: 'codebuddy',
    userAgent: 'CodeBuddyIDE/1.106.1',
  },
  {
    // WorkBuddy 与 CodeBuddy 共用同一套签到端点，差异只在「打到哪个域名」和身份头。
    // 域名不能写死：凭据里的 `domain` 是登录时的站点（.ai / .cn 都有），
    // 跟着凭据走才不会把请求发到没有该账号的另一侧（发错侧会 401）。
    // 是否存在签到活动由服务端 `active` 决定——本插件如实呈现，不猜测。
    // UA 取自 2.1.0 `WORKBUDDY_UA_INTL`，与它的 checkinHeaders 一致。
    id: 'workbuddy',
    name: 'WorkBuddy',
    org: '腾讯',
    endpointFrom: 'domain',
    apiDomain: 'www.workbuddy.ai',
    productCode: 'workbuddy',
    userAgent: 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2',
  },
  {
    id: 'codearts',
    name: 'CodeArts',
    org: '华为云',
    endpoint: 'https://snap-access.cn-north-4.myhuaweicloud.com',
  },
]

export function channelById(id) {
  return CHANNELS.find(channel => channel.id === id)
}

/** 账号池里属于指定渠道的账号（含已停用账号——签到与「是否参与自动选择」无关）。 */
export function accountsOf(provider) {
  return readAccountPool()
    .filter(entry => entry?.provider === provider && typeof entry.credentialRef === 'string')
    .map(entry => ({
      id: entry.id,
      provider: entry.provider,
      nickname: entry.nickname ?? entry.id,
      credentialRef: entry.credentialRef,
      enabled: entry.enabled !== false,
    }))
}
