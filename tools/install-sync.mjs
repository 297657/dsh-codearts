#!/usr/bin/env node
/**
 * 在「新设备」上还原同步包。
 *
 *   node install.mjs                 全流程：拷插件 → 写依赖 → 合并数据 → npm install
 *   node install.mjs --no-install    只落文件不跑 npm install（装完自己到 profiles/desktop 里执行）
 *   node install.mjs --home <目录>   指定 DSH 主目录（默认 ~/.dsh；测试/多 profile 用）
 *
 * 行为约定：
 * - 只合并、不破坏：所有被改动/覆盖的原文件先备份为 *.bak-sync-<时间戳>；
 *   账号按 id 合并、凭据按引用名合并，目标上已有且包里没有的一律保留。
 * - 插件源码落到 ~/.dsh/plugins-local/<名字>，profile 的 package.json 用 link: 绝对路径
 *   指过去（和源设备同构，改代码即时生效）。
 * - cordis.patch.yml 不会整体覆盖（里面混着本机偏好，直接盖可能踩版本差异）；
 *   只在缺失时补上 `agent-default-model`（默认模型 devcloud/GLM-5.2）这一条关键配置，
 *   其余偏好请对照包里的 data/reference-cordis.patch.yml 手工对齐。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const pkgDir = resolve(fileURLToPath(new URL('.', import.meta.url)))
const dshDir = resolve(opt('--home', join(homedir(), '.dsh')))
const profileDir = join(dshDir, 'profiles', 'desktop')
const pluginsLocal = join(dshDir, 'plugins-local')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const installed = []
const skipped = []

if (!existsSync(profileDir)) {
  console.error(`找不到 ${profileDir}`)
  console.error('请先安装并启动一次 DeepSeek Harness（生成 profile 后再运行本脚本）。')
  process.exit(1)
}

/** 备份已存在的文件；返回是否真的存在过。 */
function backup(path) {
  if (!existsSync(path)) return false
  renameSync(path, `${path}.bak-sync-${stamp}`)
  return true
}

/** 递归列出目录下所有文件（相对路径，/ 分隔）。 */
function walk(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, acc)
    else acc.push(relative(base, full).replaceAll('\\', '/'))
  }
  return acc
}

const log = message => console.log(`  ${message}`)

// ── 1. 插件源码 ──────────────────────────────────────────────────────────────
const pluginsDir = join(pkgDir, 'plugins')
const pluginKeys = existsSync(pluginsDir) ? readdirSync(pluginsDir) : []
if (pluginKeys.length === 0) {
  console.error('包里没有 plugins/ 目录，这是一个数据-only 包，请手工对照 README。')
}
mkdirSync(pluginsLocal, { recursive: true })
for (const key of pluginKeys) {
  const dest = join(pluginsLocal, key)
  const existed = existsSync(dest)
  if (existed) renameSync(dest, `${dest}.bak-sync-${stamp}`)
  cpSync(join(pluginsDir, key), dest, { recursive: true })
  installed.push(`插件 ${key}${existed ? '（旧版已备份）' : ''}`)
  log(`${existed ? '更新' : '安装'} ${key} → ${dest}`)
}

// ── 2. profile 依赖（package.json 的 link: 指向本地源码）──────────────────────
const profilePkgPath = join(profileDir, 'package.json')
const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
profilePkg.dependencies ??= {}
let depsChanged = false
for (const key of pluginKeys) {
  const name = `@local/${key}`
  const wanted = `link:${join(pluginsLocal, key).replaceAll('\\', '/')}`
  if (profilePkg.dependencies[name] !== wanted) {
    profilePkg.dependencies[name] = wanted
    depsChanged = true
  }
}
if (depsChanged) {
  backup(profilePkgPath)
  writeFileSync(profilePkgPath, JSON.stringify(profilePkg, null, 2) + '\n')
  log('已写入 profile package.json 依赖（原文件已备份）')
} else {
  log('profile 依赖无需改动')
}

// ── 3. 账号清单合并（state.json：按账号 id 合并，包优先）──────────────────────
const stateDest = join(dshDir, 'channel-pack', 'state.json')
const stateSrc = join(pkgDir, 'data', 'state.json')
if (existsSync(stateSrc)) {
  const incoming = JSON.parse(readFileSync(stateSrc, 'utf8'))
  mkdirSync(join(stateDest, '..'), { recursive: true })
  let merged = 0
  let added = 0
  if (existsSync(stateDest)) {
    const current = JSON.parse(readFileSync(stateDest, 'utf8'))
    const byId = new Map((current.accounts ?? []).map(row => [row.id, row]))
    for (const row of incoming.accounts ?? []) {
      if (byId.has(row.id)) merged += 1
      else added += 1
      byId.set(row.id, row)
    }
    current.accounts = [...byId.values()]
    // 顶层偏好：目标没有的键才从包里补，不覆盖本地已改的值。
    for (const [key, value] of Object.entries(incoming)) {
      if (key === 'accounts') continue
      if (current[key] === undefined) current[key] = value
    }
    backup(stateDest)
    writeFileSync(stateDest, JSON.stringify(current, null, 2) + '\n')
  } else {
    cpSync(stateSrc, stateDest)
    added = (incoming.accounts ?? []).length
  }
  installed.push(`账号清单（新增 ${added}、更新 ${merged}）`)
  log(`state.json 合并完成：新增 ${added} 个、更新 ${merged} 个账号`)
}

// ── 4. 凭据合并（.credentials.yaml：按顶层引用名追加缺失块）──────────────────
const credDest = join(dshDir, '.credentials.yaml')
const credSrc = join(pkgDir, 'data', 'credentials.yaml')
if (existsSync(credSrc)) {
  // 真实结构：顶层是 version / records / refs 三段，凭据都在最后的 `refs:` 段下，
  // 键为两空格缩进的 `NAME: ...`（值可能是跨行单引号串，也可能是裸字符串）。
  // 因此只在 refs: 段内切块、按「目标缺哪条补哪条」合并，records 段不动。
  const refsSection = text => {
    const at = text.search(/^refs:\s*$/m)
    return at < 0 ? null : text.slice(at)
  }
  const splitRefs = section => {
    const blocks = new Map()
    if (section === null) return blocks
    const re = /^  ([A-Z0-9_]+):/gm
    let match
    const starts = []
    while ((match = re.exec(section)) !== null) starts.push({ key: match[1], at: match.index })
    for (let i = 0; i < starts.length; i += 1) {
      const end = i + 1 < starts.length ? starts[i + 1].at : section.length
      blocks.set(starts[i].key, section.slice(starts[i].at, end))
    }
    return blocks
  }
  const incoming = splitRefs(refsSection(readFileSync(credSrc, 'utf8')))
  const currentText = existsSync(credDest) ? readFileSync(credDest, 'utf8') : ''
  const existing = splitRefs(refsSection(currentText))
  const missing = [...incoming.keys()].filter(key => !existing.has(key))
  if (missing.length > 0) {
    const addition = missing.map(key => incoming.get(key)).join('')
    let next
    if (refsSection(currentText) !== null) {
      // refs: 是最后一个顶层段 → 直接追加到文件尾即可。
      next = currentText.endsWith('\n') ? currentText + addition : `${currentText}\n${addition}`
    } else {
      next = `${currentText.replace(/\n*$/, '\n')}refs:\n${addition}`
    }
    backup(credDest)
    writeFileSync(credDest, next)
    installed.push(`凭据（追加 ${missing.length} 条）`)
    log(`credentials.yaml 追加 ${missing.length} 条凭据（原文件已备份）`)
  } else {
    skipped.push('凭据（目标已全部存在）')
    log('credentials.yaml：包里的凭据目标都已存在，未改动')
  }
}

// ── 5. 其余数据：目标缺失才拷贝（本地已有的更新，别用包里的旧 token 覆盖）──────
const dataDir = join(pkgDir, 'data')
if (existsSync(dataDir)) {
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (entry.name === 'state.json' || entry.name === 'credentials.yaml') continue
    if (entry.name === 'reference-cordis.patch.yml' || entry.name === 'profile-package.json') continue
    if (entry.name === 'our-free-model') continue // 单独处理（目标在 ~/.dsh 根，不在 channel-pack）
    const src = join(dataDir, entry.name)
    const dest = entry.name === 'env' ? join(dshDir, '.env') : join(dshDir, 'channel-pack', entry.name)
    if (existsSync(dest)) {
      skipped.push(basename(dest))
      continue
    }
    mkdirSync(join(dest, '..'), { recursive: true })
    cpSync(src, dest, { recursive: true })
    installed.push(entry.name)
    log(`已放置 ${dest}`)
  }
  // ofm 的运行数据：逐文件补缺。
  const ofmSrc = join(dataDir, 'our-free-model')
  if (existsSync(ofmSrc)) {
    const ofmDest = join(dshDir, 'our-free-model')
    let placed = 0
    for (const rel of walk(ofmSrc)) {
      const target = join(ofmDest, rel)
      if (existsSync(target)) continue
      mkdirSync(join(target, '..'), { recursive: true })
      cpSync(join(ofmSrc, rel), target)
      placed += 1
    }
    installed.push(`our-free-model 数据（补 ${placed} 个文件）`)
    log(`our-free-model：补 ${placed} 个缺失文件（已有的保持本地版本）`)
  }
}

// ── 6. 补丁层：只补关键的 agent-default-model，其余给参考文件 ────────────────
const patchPath = join(profileDir, 'cordis.patch.yml')
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8')
  if (!patch.includes('- id: agent-default-model')) {
    const addition = [
      '',
      '# 由 dsh-sync 安装器补上（同步包来自使用 CodeArts 渠道的机器）：',
      "- id: agent-default-model # magpie",
      '  config:',
      '    provider: devcloud',
      '    model: GLM-5.2',
      '    reasoningEffort: on',
      '',
    ].join('\n')
    backup(patchPath)
    writeFileSync(patchPath, patch.replace(/\n*$/, '\n') + addition)
    log('cordis.patch.yml 已补 agent-default-model（默认模型 devcloud/GLM-5.2，原文件已备份）')
    installed.push('补丁 agent-default-model')
  } else {
    log('cordis.patch.yml 已有 agent-default-model，未改动')
  }
  log('其余偏好请对照 data/reference-cordis.patch.yml 手工对齐（安装器不整体覆盖）')
}

// ── 7. npm install ───────────────────────────────────────────────────────────
if (flag('--no-install')) {
  log('已跳过 npm install（--no-install）')
} else {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  console.log(`  正在 ${profileDir} 里执行 npm install …`)
  const result = spawnSync(npm, ['install', '--omit=dev'], { cwd: profileDir, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    console.error('  npm install 失败：请手工在该目录执行 `npm install --omit=dev` 后重启 DSH。')
  }
}

console.log('\n完成。已安装/更新：')
for (const item of installed) console.log(`  + ${item}`)
for (const item of skipped) console.log(`  = 跳过 ${item}（目标已有）`)
console.log('\n请重启 DeepSeek Harness，然后到「设置 → 签到」检查各账号状态。')
if (existsSync(join(pkgDir, 'data', 'credentials.yaml'))) {
  console.log('\n⚠️ 注意：账号凭据是从另一台机器同步来的。CodeArts 的 refresh_token 一次有效，')
  console.log('   两台设备同时使用 CodeArts 会互相挤掉登录——建议只在一台设备上用 CodeArts，')
  console.log('   或在另一台上重新登录一次（设置 → 签到 → CodeArts → 添加账号）。')
}
