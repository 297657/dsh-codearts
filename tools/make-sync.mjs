#!/usr/bin/env node
/**
 * 打包本机 DSH 签到/模型环境的「同步包」，用于迁移到其他设备。
 *
 *   node make-sync.mjs                 输出到 ../dsh-sync-out/dsh-sync-<日期>/
 *   node make-sync.mjs --no-credentials  不带凭据（新设备上所有账号要重新登录）
 *   node make-sync.mjs --plugin-only    只打插件源码，不带任何账号/运行数据
 *   node make-sync.mjs --out <目录>      指定输出根目录
 *
 * 包内容与来源：
 *   plugins/dsh-codearts, plugins/dsh-workbuddy   ← 各自源码目录（排除 node_modules/.git）
 *   data/state.json, credentials.yaml, …          ← ~/.dsh/channel-pack + ~/.dsh/.credentials.yaml
 *   data/our-free-model/…                         ← ~/.dsh/our-free-model（ofm 的设置与账号数据）
 *   data/reference-cordis.patch.yml               ← profile 补丁层（944 行偏好，供新设备参考/手工对齐）
 *   data/profile-package.json                     ← profile 依赖清单（安装器据此写 link 依赖）
 *   install.mjs, README.md                        ← 安装器与说明（自身目录拷入）
 *
 * ⚠️ 默认包含凭据（refresh_token / access_token）。传输时走私密渠道（网盘私有链接、
 * 微信文件传输助手、U 盘），不要发群或公开渠道。
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, cpSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginOnly = flag('--plugin-only')
const withCredentials = !pluginOnly && !flag('--no-credentials')
// 输出放盘根（D:\dsh-sync-out），避免落在源码目录里被下一次打包误收。
const outRoot = resolve(opt('--out', resolve(here, '../../../dsh-sync-out')))
const home = homedir()
const dshDir = join(home, '.dsh')
const profileDir = join(dshDir, 'profiles', 'desktop')

const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '')
const pkgName = pluginOnly ? `dsh-plugin-${stamp}` : `dsh-sync-${stamp}`
const pkgDir = join(outRoot, pkgName)

/** 顶层键集合里第一个存在的路径。 */
function firstExisting(paths) {
  return paths.find(p => existsSync(p))
}

// ⚠️ 路径基准：本文件在 <插件>/tools/ 里，`here` 是 tools 目录。
const pluginSources = [
  { key: 'dsh-codearts', dir: resolve(here, '..') },
  { key: 'dsh-workbuddy', dir: resolve(here, '../../dsh-workbuddy') },
]
  // 防御：目录解析错了（比如指到盘根）会把整个磁盘打进去——源码目录必须自带 package.json。
  .filter(row => existsSync(row.dir) && existsSync(join(row.dir, 'package.json')))

const dataSources = [
  // 账号清单与凭据（多渠道共享：ofm 的签到账号也在这里）
  { src: join(dshDir, 'channel-pack', 'state.json'), dest: 'data/state.json', secret: true },
  withCredentials
    ? { src: join(dshDir, '.credentials.yaml'), dest: 'data/credentials.yaml', secret: true }
    : null,
  { src: join(dshDir, 'channel-pack', 'auto-checkin.json'), dest: 'data/auto-checkin.json', secret: false },
  { src: join(dshDir, 'channel-pack', 'token-ledger.json'), dest: 'data/token-ledger.json', secret: true },
  { src: join(dshDir, '.env'), dest: 'data/env', secret: true },
  // ofm 的运行数据（设置、模型可用性、订阅账号）
  { src: join(dshDir, 'our-free-model'), dest: 'data/our-free-model', dir: true, secret: true },
  // profile 层：依赖清单与补丁（补丁只做参考，不自动覆盖）
  { src: join(profileDir, 'package.json'), dest: 'data/profile-package.json', secret: false },
  { src: join(profileDir, 'cordis.patch.yml'), dest: 'data/reference-cordis.patch.yml', secret: false },
].filter(Boolean).filter(row => existsSync(row.src)).filter(() => !pluginOnly)

if (pluginSources.length === 0) {
  console.error('没有找到任何插件源码目录，中止。')
  process.exit(1)
}

/** 递归收集目录下的普通文件（跳过 node_modules / .git / 系统目录 / 日志 / 打包产物）。 */
function collectFiles(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules'
      || entry.name === '.git'
      || entry.name === 'dsh-sync-out'
      || entry.name.startsWith('$')
      || entry.name === 'System Volume Information'
      || entry.name.endsWith('.log')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(full, base, acc)
    else if (entry.isFile()) acc.push(relative(base, full).replaceAll('\\', '/'))
  }
  return acc
}

mkdirSync(pkgDir, { recursive: true })
for (const row of pluginSources) {
  const dest = join(pkgDir, 'plugins', row.key)
  mkdirSync(dest, { recursive: true })
  for (const rel of collectFiles(row.dir)) {
    const target = join(dest, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    cpSync(join(row.dir, rel), target)
  }
}

const copied = []
for (const row of dataSources) {
  const target = join(pkgDir, row.dest)
  mkdirSync(join(target, '..'), { recursive: true })
  cpSync(row.src, target, { recursive: true })
  copied.push(row.dest)
}

// 安装器与说明随包走：换设备时不需要再回来找工具。
cpSync(join(here, 'install-sync.mjs'), join(pkgDir, 'install.mjs'))
cpSync(join(here, 'SYNC-README.md'), join(pkgDir, 'README.md'))

const meta = {
  generatedAt: new Date().toISOString(),
  sourceHost: process.env.COMPUTERNAME ?? process.env.HOST ?? 'unknown',
  platform: platform(),
  withCredentials,
  pluginOnly,
  plugins: pluginSources.map(row => {
    const manifest = JSON.parse(readFileSync(join(row.dir, 'package.json'), 'utf8'))
    return { key: row.key, version: manifest.version, source: row.dir }
  }),
  data: copied,
  counts: {
    accounts: existsSync(join(pkgDir, 'data', 'state.json'))
      ? (JSON.parse(readFileSync(join(pkgDir, 'data', 'state.json'), 'utf8')).accounts ?? []).length
      : 0,
  },
}
writeFileSync(join(pkgDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')

// zip 只是「顺手」：必须用 Windows 自带的 bsdtar（System32\tar.exe，真 zip 格式，
// 资源管理器能直接解）；Git Bash 里的 GNU tar 写的 .zip 其实是 tar 包，别用。
let zipPath
try {
  const { execFileSync } = await import('node:child_process')
  const bsdtar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  zipPath = `${pkgDir}.zip`
  execFileSync(bsdtar, ['-a', '-c', '-f', zipPath, '-C', outRoot, basename(pkgDir)], { stdio: 'pipe' })
} catch {
  zipPath = undefined
}

console.log(`同步包已生成：${pkgDir}`)
for (const row of pluginSources) console.log(`  plugins/${row.key}`)
for (const dest of copied) console.log(`  ${dest}`)
console.log(pluginOnly
  ? '  纯插件包：不含任何账号数据与凭据'
  : `  账号 ${meta.counts.accounts} 个 · 凭据${withCredentials ? '【已包含，注意保密】' : '未包含'}`)
if (zipPath !== undefined) console.log(`压缩包：${zipPath}`)
console.log('\n下一步：把整个目录（或 zip）传到新设备，解压后按 README.md 执行 node install.mjs')
