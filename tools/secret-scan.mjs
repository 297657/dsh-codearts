#!/usr/bin/env node
/**
 * 提交前敏感信息扫描 —— 防止把账号数据/凭据带进仓库。
 *
 *   node tools/secret-scan.mjs           扫描工作区全部被 git 跟踪的文件
 *   node tools/secret-scan.mjs --staged  只扫暂存区（pre-commit 钩子用法）
 *
 * 命中即退出码 1，并列出 文件:行号:类别。只报告模式，不回显命中的具体值。
 *
 * 设计口径：只看「字面量」，不误伤文档里出现的字段名（如 refresh_token 这个词）。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'

const staged = process.argv.includes('--staged')
const run = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/** 每类一行正则；命中即视为敏感。 */
const RULES = [
  ['JWT/令牌字面量', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/],
  ['Authorization 头', /Authorization\s*:\s*['"]?(Bearer|Basic)\s+[A-Za-z0-9._+/=-]{20,}/i],
  ['refresh_token 赋值', /refresh_token\s*[:=]\s*['"][A-Za-z0-9._-]{20,}['"]/],
  ['access_token 赋值', /access_token\s*[:=]\s*['"][A-Za-z0-9._-]{20,}['"]/],
  ['AK/SK 赋值', /\b(access[_-]?key([_-]?id)?|secret[_-]?key|ak|sk)\s*[:=]\s*['"][A-Za-z0-9/+]{16,}['"]/i],
  ['私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['邮箱', /[A-Za-z0-9._%+-]+@(qq|163|126|gmail|outlook|hotmail)\.com/i],
  ['手机号', /(?<!\d)1[3-9]\d{9}(?!\d)/],
  ['用户名家目录', /[A-Za-z]:[\\/]Users[\\/](?!xxx|user\b|username\b)[A-Za-z0-9._-]+/i],
]

/** 整份文件就不该入库的类型（即便被 git add -f 也拦）。 */
const FORBIDDEN_FILES = [
  /(^|\/)\.credentials\.ya?ml$/,
  /(^|\/)state\.json$/,
  /(^|\/)token-ledger\.json$/,
  /(^|\/)auto-checkin\.json$/,
  /(^|\/)\.env$/,
  /\.bak-sync-[\dT-]+$/,
  /(^|\/)our-free-model\//,
]

const files = (staged
  ? run(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
  : run(['ls-files'])
).split('\n').map(s => s.trim()).filter(Boolean)

const findings = []
for (const file of files) {
  const hit = FORBIDDEN_FILES.find(re => re.test(file))
  if (hit) {
    findings.push({ file, line: 0, kind: '禁止入库的文件类型' })
    continue
  }
  let text
  try {
    if (statSync(file).size > 2 * 1024 * 1024) continue
    text = readFileSync(file, 'utf8')
  } catch {
    continue // 二进制/不可读，跳过
  }
  if (text.includes('\u0000')) continue
  text.split('\n').forEach((line, i) => {
    for (const [kind, re] of RULES) {
      if (re.test(line)) findings.push({ file, line: i + 1, kind })
    }
  })
}

if (findings.length === 0) {
  console.log(`✓ 敏感信息扫描通过（${files.length} 个文件）`)
  process.exit(0)
}

console.error('✗ 发现疑似敏感信息，已阻止提交：\n')
for (const f of findings) {
  console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}  [${f.kind}]`)
}
console.error('\n处理方式：把该数据移到 ~/.dsh/ 等仓库外位置，或用环境变量/占位符替代。')
console.error('确认是误报时：git commit --no-verify（不推荐，请在提交说明里写明原因）')
process.exit(1)
