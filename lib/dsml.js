/**
 * deepseek-v4 的 DSML 工具模式。
 *
 * 为什么需要它：deepseek-v4-flash / deepseek-v4-pro 在 CodeArts 网关上**不认**
 * 标准 `tools` + `tool_calls` 通道——发了 `tools` 它也只在正文里输出一段
 * `<｜DSML｜tool_calls>` 文本。所以这类模型必须换一套协议：
 *
 *  1. 不发 `tools` 字段，改为把「工具清单 + DSML 语法说明」写进 system 提示词；
 *  2. 从 `delta.content` / `delta.reasoning_content` 的正文里解析出 DSML 块，
 *     再翻译回标准的 tool-call 块。
 *
 * 标记用的是**全角竖线** `｜`（U+FF5C），不是 ASCII 的 `|`——写成后者模型能看懂
 * 但解析器对不上。为免源码编码出岔子，常量一律用 `\uFF5C` 转义构造。
 *
 * 解析器是**流式状态机**：标记可能被切在两个 chunk 里（实测 SSE 边界完全随机），
 * 所以遇到「像是某个标记的前半截」时必须先扣住不发，否则会把
 * `<｜DSML｜tool_` 当正文吐给用户。这一步由 `holdTail()` 负责。
 */

const BAR = '\uFF5C'

export const TOOL_CALLS_OPEN = `<${BAR}DSML${BAR}tool_calls>`
export const TOOL_CALLS_CLOSE = `</${BAR}DSML${BAR}tool_calls>`
const INVOKE_OPEN = `<${BAR}DSML${BAR}invoke`
const INVOKE_CLOSE = `</${BAR}DSML${BAR}invoke>`
const PARAM_OPEN = `<${BAR}DSML${BAR}parameter`
const PARAM_CLOSE = `</${BAR}DSML${BAR}parameter>`

/**
 * 部分模型会把思考内容写成 `<thought>…</thought>` 混在正文里。
 * 与 DSML 块一起处理，顺手拆出 reasoning。
 */
const THOUGHT_OPEN = '<thought>'
const THOUGHT_CLOSE = '</thought>'

/**
 * 这些模型必须走 DSML；其余模型用标准 tool_calls。
 *
 * ⚠️ 只认 `v4-(flash|pro)`，**不要**顺手写成 `v4(\.\d+)?`。实测
 * `deepseek-v4.1-flash` 是支持标准 `tools` + `tool_calls` 的：给它发标准请求会
 * 正常返回 tool-call 分片与 `finish: tool-calls`。把它拉进 DSML 反而会让本来
 * 好用的模型变成纯文本回答。
 */
export function needsDsmlToolMode(model) {
  return /^deepseek-v4-(?:flash|pro)$/i.test(String(model ?? ''))
}

/**
 * 把工具清单渲染成 DSML 说明，作为额外一条 system 消息发出。
 *
 * `tools` 是 wire 格式（`{ type: 'function', function: {...} }`）。
 */
export function buildDsmlSystemPrompt(tools) {
  const toolJson = JSON.stringify(
    tools.map(tool => ({
      name: tool?.function?.name,
      description: tool?.function?.description,
      parameters: tool?.function?.parameters,
    })),
    null,
    2,
  )

  // 这条提示只在真有写文件工具时才给。凭空提一个不存在的 write 工具，
  // 模型会照着自己编一个调过来，然后失败。
  const hasWriteTool = tools.some(tool => /^(write|write_file|create_file|edit_file)$/i
    .test(String(tool?.function?.name ?? '')))

  return [
    '以下是你可用的工具及其 JSON Schema。当需要调用工具完成任务时，',
    '必须使用原生 DSML 工具调用语法输出，格式如下：',
    `${TOOL_CALLS_OPEN}<${BAR}DSML${BAR}invoke name="工具名">`
      + `<${BAR}DSML${BAR}parameter name="参数名" string="true">参数值${PARAM_CLOSE}`
      + `${INVOKE_CLOSE}${TOOL_CALLS_CLOSE}`,
    '',
    '规则：',
    '- 工具名必须是下面列表中的 name。',
    `- 每个参数用一个 ${PARAM_OPEN}> 标签包裹，参数值放在标签之间。`,
    '- 字符串参数加 string="true" 属性；对象/数组/数字/布尔参数不要加该属性。',
    `- 一次可以输出多个 ${INVOKE_OPEN}> 调用（工具可以并行）。`,
    ...hasWriteTool
      ? ['- 文件内容请一次性完整写入单个写文件调用的 content 参数，不要拆分或省略。']
      : [],
    '- 不要在正文里解释你要调用什么，直接输出上面的标记块。',
    '',
    '工具列表（JSON Schema）：',
    toolJson,
  ].join('\n')
}

/** 把 DSML 里的裸标量还原成 JSON 值：`true`/`42`/`{"a":1}`/`"带引号"`。 */
function tryParseScalar(value) {
  if (value === '') return ''
  const trimmed = value.trim()
  if (trimmed === '') return value
  if (trimmed === 'null') return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false

  // 被 JSON 转义过的字符串（模型偶尔会把内容写成 "\"..."），解开后再递归一次
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed)
      if (typeof decoded === 'string') return tryParseScalar(decoded)
      return decoded
    } catch { /* 不是合法 JSON 字符串，按原样返回 */ }
  }

  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed)
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed) } catch { /* 落回原字符串 */ }
  }
  return value
}

/** 解析单个 `<｜DSML｜invoke>…</｜DSML｜invoke>` 块。缺 name 时返回 undefined。 */
function parseInvoke(block) {
  const nameMatch = /name\s*=\s*"([^"]*)"/.exec(block)
  // 空 name（`name=""`）同样算解析失败：调用发不出去，**也不能静默丢掉**，
  // 否则模型说的话就从界面上凭空消失。让调用方把整块当正文回显。
  if (nameMatch === null || nameMatch[1] === '') return undefined
  const name = nameMatch[1]

  const params = {}
  let cursor = 0
  for (;;) {
    const openStart = block.indexOf(PARAM_OPEN, cursor)
    if (openStart === -1) break
    const openEnd = block.indexOf('>', openStart)
    if (openEnd === -1) break

    const openTag = block.slice(openStart, openEnd + 1)
    const paramNameMatch = /name\s*=\s*"([^"]*)"/.exec(openTag)
    if (paramNameMatch === null) {
      cursor = openEnd + 1
      continue
    }

    const closeStart = block.indexOf(PARAM_CLOSE, openEnd + 1)
    if (closeStart === -1) break

    const value = block.slice(openEnd + 1, closeStart)
    const isString = /string\s*=\s*"true"/.test(openTag)
    if (isString) {
      params[paramNameMatch[1]] = tryParseScalar(value)
    } else {
      try {
        const parsed = JSON.parse(value)
        params[paramNameMatch[1]] = typeof parsed === 'string' ? tryParseScalar(parsed) : parsed
      } catch {
        // 非字符串参数写成裸文本（如 `{a: 1}`）时 JSON 会失败，保留原文交给工具校验
        params[paramNameMatch[1]] = value
      }
    }
    cursor = closeStart + PARAM_CLOSE.length
  }

  return { name, arguments: JSON.stringify(params) }
}

/** 解析整个 `<｜DSML｜tool_calls>` 块为若干次调用。任一 invoke 缺 name 就整块判为正文。 */
export function parseToolCalls(block) {
  let inner = block
  if (inner.startsWith(TOOL_CALLS_OPEN)) inner = inner.slice(TOOL_CALLS_OPEN.length)
  if (inner.endsWith(TOOL_CALLS_CLOSE)) inner = inner.slice(0, inner.length - TOOL_CALLS_CLOSE.length)

  const calls = []
  let cursor = 0
  for (;;) {
    const openStart = inner.indexOf(INVOKE_OPEN, cursor)
    if (openStart === -1) break
    const openEnd = inner.indexOf('>', openStart)
    if (openEnd === -1) break
    const closeStart = inner.indexOf(INVOKE_CLOSE, openEnd + 1)
    if (closeStart === -1) break

    const parsed = parseInvoke(inner.slice(openStart, closeStart + INVOKE_CLOSE.length))
    if (parsed === undefined) return undefined
    calls.push(parsed)
    cursor = closeStart + INVOKE_CLOSE.length
  }
  return calls
}

/** 缓冲区末尾有多少字符是某个标记的前半截——这些必须扣住，不能当正文发出。 */
function holdTail(buffer, prefixes) {
  let keep = 0
  const maxCheck = Math.min(buffer.length, Math.max(...prefixes.map(prefix => prefix.length)))
  for (let i = 1; i <= maxCheck; i++) {
    const tail = buffer.slice(buffer.length - i)
    if (prefixes.some(prefix => prefix.startsWith(tail))) keep = i
  }
  return keep
}

/**
 * 流式提取器：喂 SSE delta 的正文，吐出 { text, reasoning, toolCalls }。
 *
 * 状态机三态：`normal`（数正文）、`in-thought`（数思考）、`in-dsml`（等块闭合）。
 * 一次 `feed` 可能跨多个块，所以内部用 while 循环反复消费缓冲区。
 */
export class DsmlExtractor {
  #buffer = ''
  #state = 'normal'

  feed(chunk) {
    let text = ''
    let reasoning = ''
    const toolCalls = []
    this.#buffer += chunk

    for (;;) {
      if (this.#state === 'normal') {
        const thoughtIdx = this.#buffer.indexOf(THOUGHT_OPEN)
        const dsmlIdx = this.#buffer.indexOf(TOOL_CALLS_OPEN)

        let openIdx = -1
        let nextState = 'in-thought'
        if (thoughtIdx !== -1 && (dsmlIdx === -1 || thoughtIdx < dsmlIdx)) {
          openIdx = thoughtIdx
        } else if (dsmlIdx !== -1) {
          openIdx = dsmlIdx
          nextState = 'in-dsml'
        }

        if (openIdx === -1) {
          // 没有完整标记：把「可能是标记前缀」的尾巴留下，其余立刻发出去
          const keep = holdTail(this.#buffer, [THOUGHT_OPEN, TOOL_CALLS_OPEN])
          if (keep === 0) {
            text += this.#buffer
            this.#buffer = ''
          } else if (this.#buffer.length > keep) {
            text += this.#buffer.slice(0, this.#buffer.length - keep)
            this.#buffer = this.#buffer.slice(this.#buffer.length - keep)
          }
          break
        }

        if (openIdx > 0) text += this.#buffer.slice(0, openIdx)
        this.#buffer = this.#buffer.slice(openIdx)
        this.#buffer = this.#buffer.slice(
          nextState === 'in-thought' ? THOUGHT_OPEN.length : TOOL_CALLS_OPEN.length,
        )
        this.#state = nextState
        continue
      }

      if (this.#state === 'in-thought') {
        const closeIdx = this.#buffer.indexOf(THOUGHT_CLOSE)
        if (closeIdx === -1) {
          const keep = holdTail(this.#buffer, [THOUGHT_CLOSE])
          if (keep === 0) {
            reasoning += this.#buffer
            this.#buffer = ''
          } else if (this.#buffer.length > keep) {
            reasoning += this.#buffer.slice(0, this.#buffer.length - keep)
            this.#buffer = this.#buffer.slice(this.#buffer.length - keep)
          }
          break
        }
        if (closeIdx > 0) reasoning += this.#buffer.slice(0, closeIdx)
        this.#buffer = this.#buffer.slice(closeIdx + THOUGHT_CLOSE.length)
        this.#state = 'normal'
        continue
      }

      // in-dsml：必须等到闭合标记才能解析（参数是逐字符流过来的）
      const closeIdx = this.#buffer.indexOf(TOOL_CALLS_CLOSE)
      if (closeIdx === -1) break

      const block = this.#buffer.slice(0, closeIdx + TOOL_CALLS_CLOSE.length)
      const parsed = parseToolCalls(block)
      if (parsed === undefined) {
        // 解析不了就按正文发出去，别把模型想说的话吞掉。
        // 开标记此时已从缓冲区剥掉了，回显时要补回去，否则用户看到的是半截。
        text += TOOL_CALLS_OPEN + block
      } else {
        toolCalls.push(...parsed)
      }
      this.#buffer = this.#buffer.slice(closeIdx + TOOL_CALLS_CLOSE.length)
      this.#state = 'normal'
    }

    return { text, reasoning, toolCalls }
  }

  /** 流结束时把扣住的尾巴吐出来。未闭合的 DSML 块原样还原成正文。 */
  flush() {
    const remaining = this.#buffer
    this.#buffer = ''
    if (this.#state === 'in-thought') {
      this.#state = 'normal'
      return { text: '', reasoning: remaining, toolCalls: [] }
    }
    if (this.#state === 'in-dsml') {
      this.#state = 'normal'
      return { text: TOOL_CALLS_OPEN + remaining, reasoning: '', toolCalls: [] }
    }
    this.#state = 'normal'
    return { text: remaining, reasoning: '', toolCalls: [] }
  }
}
