#!/usr/bin/env node
/**
 * 一键安装 dsh-codearts 到 DSH Go 手机本机引擎（也可用于电脑）。
 *
 * 设计目标：让手机上的 DSH Go agent 下载本仓库 zip 后，只跑 `node tools/install-phone.mjs`
 * 就能完成安装。全程只用 Node 内置模块，不依赖 git / npm install / 网络。
 *
 * 它做三件事：
 *   1. 把本仓库源码拷到 <DSH_HOME>/plugins-local/dsh-codearts
 *   2. 在profile 的 package.json 里写 link: 依赖 + bundles，并在
 *      node_modules/@local/ 建软链（不跑 npm install，避免手机端依赖解析失败）
 *   3. 只改这三个配置文件，且改前备份；绝不碰账号清单/凭据/token 台账
 *
 * 用法：
 *   node tools/install-phone.mjs                 自动探测 DSH_HOME 与所有 profile
 *   node tools/install-phone.mjs --home /root/.dsh --profile desktop
 *   node tools/install-phone.mjs --dry-run       只打印将要做什么，不落盘
 *
 * 幂等：重复运行只更新源码、不叠加依赖；每次改动先留 .bak-phone-<时间戳>。
 */

import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, symlinkSync, lstatSync, writeFileSync, readlinkSync,
} from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const flag = n => argv.includes(n)
const opt = (n, fb) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : fb }
const dry = flag('--dry-run')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

// 本脚本在 <仓库>/tools/ 下；仓库根就是上一级。
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const manifestPath = join(repoRoot, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`[install-phone] 找不到仓库根 package.json（${manifestPath}）。请在解压后的 dsh-codearts 目录里运行本脚本。`)
  process.exit(1)
}
const version = JSON.parse(readFileSync(manifestPath, 'utf8')).version

const log = (...a) => console.log('[install-phone]', ...a)

/** 探测 DSH 主目录：显式参数 > 环境变量 > 手机/桌面常见位置。 */
function findHome() {
  const given = opt('--home', null)
  const candidates = [
    given,
    process.env.DSH_HOME,
    join(homedir(), '.dsh'),
    '/root/.dsh',
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(join(c, 'profiles'))) return resolve(c)
  }
  console.error('[install-phone] 找不到 DSH 主目录（下面都没有 profiles/ 目录）：')
  for (const c of candidates) console.error('   ' + c)
  console.error('请确认本机引擎已启动过一次，或用 --home 指定 .dsh 目录。')
  process.exit(1)
}

/** 找出要装的 profile 目录（含 package.json 的那些）。 */
function findProfiles(home) {
  const only = opt('--profile', null)
  const base = join(home, 'profiles')
  let names
  if (only) {
    names = [only]
  } else {
    names = readdirSync(base).filter(n => existsSync(join(base, n, 'package.json')))
  }
  // 优先 desktop 排前面；其余按名字序。全部都装，避免漏掉当前活跃 profile。
  names.sort((a, b) => (a === 'desktop' ? -1 : b === 'desktop' ? 1 : a.localeCompare(b)))
  const found = names.filter(n => existsSync(join(base, n, 'package.json')))
  if (found.length === 0) {
    console.error(`[install-phone] 在 ${base} 下没有找到含 package.json 的 profile。`)
    process.exit(1)
  }
  return found
}

// 只拷插件运行必需的文件，排除 tools/ docs/ .git 等。
const copyItems = ['index.js', 'client.js', 'lib', 'cordis.patch.yml', 'package.json', 'README.md']
function copySource(dest) {
  if (dry) { log(`(dry-run) 拷贝源码 → ${dest}`); return }
  mkdirSync(dest, { recursive: true })
  for (const item of copyItems) {
    const src = join(repoRoot, item)
    if (!existsSync(src)) continue
    cpSync(src, join(dest, item), { recursive: true })
  }
  log(`源码已更新 → ${dest}（v${version}）`)
}

/** 备份后写回；返回是否真的改动。 */
function writeChanged(path, text) {
  let current = null
  try { current = readFileSync(path, 'utf8') } catch {}
  if (current === text) return false
  if (current !== null && !dry) renameSync(path, `${path}.bak-phone-${stamp}`)
  if (!dry) writeFileSync(path, text)
  return true
}

function patchProfile(profileDir, pluginDest) {
  const pkgPath = join(profileDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

  // 1) link: 依赖（绝对路径最稳，和电脑端同构）
  pkg.dependencies ??= {}
  const wanted = `link:${pluginDest.replace(/\\/g, '/')}`
  const depChanged = pkg.dependencies['@local/dsh-codearts'] !== wanted
  if (depChanged) pkg.dependencies['@local/dsh-codearts'] = wanted

  // 2) bundles：有这个数组且没登记就追加
  let bundleChanged = false
  const bundles = pkg.dsh?.profile?.bundles
  if (Array.isArray(bundles) && !bundles.includes('@local/dsh-codearts')) {
    bundles.push('@local/dsh-codearts')
    bundleChanged = true
  }

  if (depChanged || bundleChanged) {
    const text = JSON.stringify(pkg, null, 2) + '\n'
    const changed = writeChanged(pkgPath, text)
    if (!dry && changed) log(`  配置已更新 ${pkgPath}（原文件已备份）`)
  } else {
    log('  配置无需改动（已是最新）')
  }

  // 3) 软链：直接建，省去 npm install（手机上最稳）
  const localDir = join(profileDir, 'node_modules', '@local')
  const linkPath = join(localDir, 'dsh-codearts')
  let needLink = true
  try {
    if (lstatSync(linkPath).isSymbolicLink()) {
      needLink = resolve(readlinkSync(linkPath)) !== resolve(pluginDest)
    } else {
      // 真实目录：先备份再换成软链
      if (!dry) renameSync(linkPath, `${linkPath}.bak-phone-${stamp}`)
    }
  } catch {
    needLink = true // 不存在
  }
  if (needLink) {
    if (dry) log(`  (dry-run) 建软链 ${linkPath} → ${pluginDest}`)
    else {
      mkdirSync(localDir, { recursive: true })
      try { symlinkSync(pluginDest, linkPath, platform() === 'win32' ? 'junction' : undefined) }
      catch (e) { log(`  软链失败（${e.message}），可改为运行 npm install`); return }
      log(`  软链已建立 → ${pluginDest}`)
    }
  } else {
    log('  软链已指向正确位置')
  }
}


// ── 主流程 ───────────────────────────────────────────────────────────────────
const home = findHome()
const profiles = findProfiles(home)
const pluginDest = join(home, 'plugins-local', 'dsh-codearts')

log(`DSH_HOME = ${home}`)
log(`version  = ${version}`)
log(`profiles = ${profiles.join(', ')}`)
if (dry) log('DRY-RUN：以下操作不会真正落盘')

copySource(pluginDest)
for (const name of profiles) {
  const profileDir = join(home, 'profiles', name)
  log(`处理 profile: ${name}`)
  patchProfile(profileDir, pluginDest)
}

console.log('')
log('完成。接下来请在 DSH Go 里：设置 › 本机引擎 › 重启引擎。')
log('重启后到 设置 › 插件 确认 dsh-codearts 已安装；首次使用需在各渠道重新登录账号。')
log('提示：CodeArts 的 refresh_token 是一次性的，手机和电脑不要共用同一份凭据。')
