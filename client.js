/**
 * @local/dsh-codearts —— 浏览器半身。
 *
 * 只做一件事：在「设置」里注册一个签到页，把宿主半身 `/api/codearts-checkin`
 * 的结果画出来，并提供「立即签到 / 刷新」两个动作。
 *
 * 约定（与宿主半身一致）：
 * - 不发任何签到请求以外的调用，不改凭据，不碰模型路由；
 * - 状态词表固定为 checked-in / claimable / inactive / error，未知值按 error 展示。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-codearts',
  factory: require => {
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useCallback } = React

    const module = { exports: {} }
    const exports = module.exports

    const inject = ['slots']

    const API = (() => {
      try { return new URL('api/codearts-checkin', document.baseURI).pathname } catch { return '/api/codearts-checkin' }
    })()

    async function api(path, opts = {}) {
      const { timeout = 60_000, ...fetchOpts } = opts
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const res = await fetch(`${API}${path}`, { ...fetchOpts, redirect: 'error', signal: ctrl.signal })
        const text = await res.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const CSS = `.dcs_root{--ease:cubic-bezier(.16,1,.3,1);display:flex;flex-direction:column;gap:14px;max-width:1080px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased}.dcs_root *{box-sizing:border-box}.dcs_head{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}.dcs_titles{display:flex;flex-direction:column;gap:6px;min-width:0}.dcs_titles h2{margin:0;font-size:23px;font-weight:760;letter-spacing:-.6px;line-height:1.2}.dcs_sub{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:70ch}.dcs_pills{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}.dcs_pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.dcs_dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex-shrink:0}.dcs_dot.ok{background:var(--dsw-alias-state-success-primary)}.dcs_dot.warn{background:var(--dsw-alias-state-warn-primary)}.dcs_dot.err{background:var(--dsw-alias-state-error-primary)}.dcs_dot.idle{background:var(--dsw-alias-label-tertiary)}.dcs_sec{display:flex;flex-direction:column;gap:10px}.dcs_sechead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dcs_sec_title{font-size:14px;font-weight:680;letter-spacing:-.2px}.dcs_sec_hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto}.dcs_panel{display:flex;flex-direction:column;gap:8px;padding:12px 13px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3)}.dcs_chanacts{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin:-2px 0 2px}.dcs_row{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}.dcs_row+.dcs_row{padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}.dcs_who{display:flex;flex-direction:column;gap:2px;min-width:150px}.dcs_who b{font-size:12.5px;font-weight:620}.dcs_who span{font-size:10.5px;color:var(--dsw-alias-label-tertiary);word-break:break-all}.dcs_msg{font-size:11.5px;color:var(--dsw-alias-label-secondary);flex:1;min-width:180px}.dcs_dim{margin-top:2px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}.dcs_off{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-tertiary)}.dcs_rowacts{display:flex;gap:6px;flex-shrink:0;margin-left:auto}.dcs_btn.danger{color:var(--dsw-alias-state-error-primary)}.dcs_btn.danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}.dcs_btn{font:inherit;font-size:12px;font-weight:580;padding:6px 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .2s var(--ease)}.dcs_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.dcs_btn:disabled{opacity:.45;cursor:default}.dcs_btn.primary{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1)}.dcs_btn.ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}.dcs_btn.ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}.dcs_note{margin:0;font-size:11.5px;color:var(--dsw-alias-label-secondary)}.dcs_actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.dcs_err{color:var(--dsw-alias-state-error-primary)}.dcs_notice{margin:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent);border-radius:9px;padding:7px 10px}.dcs_dup{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);font-size:10.5px;color:var(--dsw-alias-state-warn-primary)}.dcs_notice.warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 32%,transparent)}.dcs_notice.info{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}.dcs_notice_time{margin-left:4px;font-size:10.5px;opacity:.62;white-space:nowrap}`

    // 会话面板的样式单独一段，避免去改上面那行超长的 CSS 常量。
    const CSS_EXTRA = [
      '.dcs_sess{margin-top:10px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:6px}',
      '.dcs_sesshead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dcs_sesstitle{font-size:12.5px;font-weight:660}',
      '.dcs_sessacts{margin-left:auto;display:flex;gap:8px}',
      '.dcs_sessrow{display:flex;align-items:center;gap:10px;font-size:12px;flex-wrap:wrap}',
      '.dcs_sessmodel{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}',
    ].join('')

    const STATE = {
      'checked-in': { label: '已签到', tone: 'ok' },
      claimable: { label: '待签到', tone: 'warn' },
      inactive: { label: '无活动', tone: 'idle' },
      error: { label: '异常', tone: 'err' },
    }

    function Dot({ tone }) {
      return h('span', { className: `dcs_dot ${tone}` })
    }

    function Badge({ state }) {
      const meta = STATE[state] ?? { label: state === undefined ? '未知' : String(state), tone: 'err' }
      return h('span', { className: 'dcs_pill' }, h(Dot, { tone: meta.tone }), meta.label)
    }

    function Section({ title, hint, children }) {
      return h('section', { className: 'dcs_sec' },
        h('div', { className: 'dcs_sechead' },
          h('span', { className: 'dcs_sec_title' }, title),
          hint === undefined ? null : h('span', { className: 'dcs_sec_hint' }, hint)),
        children)
    }

    /** 账号行的次要信息：连续天数、本次领取、累计领取。 */
    function detailOf(row) {
      const parts = []
      if (typeof row.streakDays === 'number' && row.streakDays > 0) parts.push(`连续 ${row.streakDays} 天`)
      if (typeof row.amount === 'number') parts.push(`本次 +${row.amount}`)
      if (typeof row.credit === 'number' && row.credit > 0) parts.push(`+${row.credit} 分`)
      if (typeof row.totalCredits === 'number') parts.push(`累计 ${thousands(row.totalCredits)}`)
      return parts.join(' · ')
    }

    /**
     * 金额一律给到具体数字（`8,018.34`），不做 `8.0K` 这种缩写。
     *
     * 缩写省不了多少宽度，却让人没法核对——用户明确要求「所有的都显示具体数据」。
     */
    function thousands(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
    }

    /**
     * 相对时间：`刚刚 / 3 分钟前 / 2 小时前`。
     *
     * 后台提示（添加失败、重复拦截）存活 10 分钟，没有时间戳时，用户刷新一次
     * 就会把几分钟前的红字当成「刚刚又失败了」——这是它误导人的根源。
     */
    function agoText(at) {
      if (typeof at !== 'number' || !Number.isFinite(at)) return ''
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
      if (seconds < 45) return '刚刚'
      if (seconds < 90) return '1 分钟前'
      if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
      return `${Math.round(seconds / 3600)} 小时前`
    }

    /** 余额行：剩余 / 总 / 已用 / 即将过期。重复账号不显示（同一份额度）。 */
    function creditLine(row) {
      const credit = row.credit
      if (row.duplicateOf !== undefined) return ''
      if (credit === undefined || credit === null) return ''
      const parts = []
      if (typeof credit.total === 'number') parts.push(`剩余积分 ${thousands(credit.total)}`)
      if (typeof credit.amount === 'number') parts.push(`总 ${thousands(credit.amount)}`)
      if (typeof credit.used === 'number') parts.push(`已用 ${thousands(credit.used)}`)
      if (typeof credit.expiring === 'number' && credit.expiring > 0) parts.push(`即将过期 ${thousands(credit.expiring)}`)
      return parts.join(' · ')
    }

    /**
     * 积分包明细：按包名聚合后取「剩余/总额」最大的三类。
     *
     * 必须聚合：腾讯系实际会给 10~20 个包，但包名只有两三种
     * （实测 momo 12 个包 / 2 个包名，ID 未展示 14 个包 / 3 个包名）。
     * 逐个列出来是一堵墙，按名字加起来才是用户想看的那几个数。
     */
    function packageLine(row) {
      if (row.duplicateOf !== undefined) return ''
      const packages = row.credit?.packages
      if (!Array.isArray(packages) || packages.length < 2) return ''

      // CodeArts 的 `metrics` 里除了各积分包还有一个「总积分包」汇总行：
      // 和明细一起列会重复计算（看上去像 16,000，实际只有 8,018）。
      const detail = packages.filter(pkg => !/^总/.test(pkg.name ?? ''))
      const source = detail.length > 1 ? detail : packages

      const groups = new Map()
      for (const pkg of source) {
        const name = pkg.name || '积分包'
        const entry = groups.get(name) ?? { name, remaining: 0, total: 0, count: 0 }
        if (typeof pkg.remaining === 'number') entry.remaining += pkg.remaining
        if (typeof pkg.total === 'number') entry.total += pkg.total
        entry.count += 1
        groups.set(name, entry)
      }

      const round = value => Math.round(value * 100) / 100
      const shown = [...groups.values()]
        .sort((a, b) => b.remaining - a.remaining)
        .slice(0, 3)
        .map(entry => `${entry.name} ${thousands(round(entry.remaining))}/${thousands(round(entry.total))}`)
        .join(' · ')

      return groups.size > 3
        ? `${shown} · 等 ${groups.size} 类（共 ${source.length} 个包）`
        : shown
    }

    const PHASE_LABEL = {
      connecting: '连接中',
      'waiting-response': '等待响应',
      streaming: '输出中',
      aborting: '已终止',
      done: '收尾',
    }

    const QUEUE_LABEL = {
      waiting: '排队中',
      working: '空闲（可接新请求）',
      queue_full: '队列已满',
      error: '异常',
    }

    /**
     * 「会话」面板。
     *
     * 服务端没有列出/关闭会话的接口，所以这里呈现的是**本插件自己发起的流**：
     * 每一路都能看到模型、阶段、已跑多久，并且可以就地终止——终止即断流，
     * 服务端的并发名额随之释放。这正是「无法关闭会话」那个问题的可用解。
     */
    function SessionsBlock({ sessions, queue, onAbort, onProbe, busy }) {
      if (sessions === null) return null
      const limit = sessions.limit ?? 3
      const rows = sessions.inflight ?? []
      const accounts = sessions.accounts ?? []
      const queued = accounts.reduce((sum, row) => sum + (row.queued ?? 0), 0)
      const cooling = accounts
        .filter(row => row.cooldown !== undefined && row.cooldown !== null)
        .map(row => `${row.nickname || row.accountId} ${Math.ceil((row.cooldown.remainingMs ?? 0) / 1000)}s`)

      return h('div', { className: 'dcs_sess' },
        h('div', { className: 'dcs_sesshead' },
          h('span', { className: 'dcs_sesstitle' }, `会话 ${rows.length} / ${limit * Math.max(1, accounts.length || 1)}`),
          h('span', { className: 'dcs_dim' }, `每账号上限 ${limit}` + (queued > 0 ? ` · 本机排队 ${queued}` : '')),
          h('div', { className: 'dcs_sessacts' },
            h('button', {
              type: 'button', className: 'dcs_btn ghost', disabled: busy,
              onClick: onProbe, title: '向服务端查一次该模型的排队状态（只读）',
            }, '检查排队'),
            h('button', {
              type: 'button', className: 'dcs_btn ghost danger',
              disabled: busy || rows.length === 0,
              onClick: onAbort,
            }, '终止全部'))),
        rows.length === 0
          ? h('p', { className: 'dcs_note dcs_dim' }, '当前没有进行中的请求。')
          : rows.map(row => h('div', { className: 'dcs_sessrow', key: row.id },
            h('span', { className: 'dcs_sessmodel' }, row.model),
            h('span', { className: 'dcs_dim' },
              `${PHASE_LABEL[row.phase] ?? row.phase} · ${(row.elapsedMs / 1000).toFixed(0)}s · ${row.nickname || row.accountId}`))),
        cooling.length > 0
          ? h('p', { className: 'dcs_note dcs_dim' }, `冷却中：${cooling.join('，')}（并发占满后自动换账号）`)
          : null,
        queue === undefined || queue === null
          ? null
          : h('p', { className: 'dcs_note dcs_dim' },
            queue.available === false
              ? `服务端排队：查不到（${queue.message ?? '未知原因'}）`
              : `服务端排队：${QUEUE_LABEL[queue.status] ?? queue.status}`
                + ` · 队列 ${queue.queueLength ?? 0} · ${queue.model}`))
    }

    function ChannelCard({ channel, onAct, onAdd, acting, adding, sessions, queue, onAbortSessions, onProbeQueue }) {
      const total = channel.accounts.length
      // 同一华为云账号被登录两次时，它的额度只能算一次：否则标题行的「剩余」
      // 会显示成两倍（用户看到的就是「积分不准确」）。
      const creditTotal = channel.accounts.reduce(
        (sum, row) => sum + (row.duplicateOf === undefined && typeof row.credit?.total === 'number'
          ? row.credit.total
          : 0), 0)
      const hint = `${channel.org} · ${total} 个账号 · 已签 ${channel.checkedInCount}`
        + (channel.claimableCount > 0 ? ` · 待签 ${channel.claimableCount}` : '')
        + (channel.errorCount > 0 ? ` · 异常 ${channel.errorCount}` : '')
        // 与 ofm 的账号卡一样，把「剩余积分」放在标题行，一眼能看到额度快没了。
        + (creditTotal > 0 ? ` · 剩余 ${thousands(creditTotal)}` : '')
      // 三家都支持在页面内登录：腾讯系走 auth/state 轮询，CodeArts 走
      // 本地回调 OAuth（PKCE + DPoP）。CodeArts 的临时凭据会被自动续期，
      // 所以这里不再需要「请先创建 AK/SK」那种手工步骤。
      const addHint = channel.id === 'codearts'
        ? '用华为云账号在浏览器授权登录；临时凭据由本插件自动续期。'
        : '用浏览器授权登录，完成后账号会自动出现在列表里。'

      return h(Section, { title: channel.name, hint },
        h('div', { className: 'dcs_panel' },
          h('div', { className: 'dcs_chanacts' },
            h('button', {
              type: 'button', className: 'dcs_btn ghost',
              disabled: adding !== '',
              onClick: () => onAdd(channel),
            }, adding === channel.id ? '正在打开授权页…' : '添加账号')),
          // 后台登录的成败只在这里说：否则「点了一次没反应」会让人反复点。
          // 每条都带时间：不带时间的话，十分钟前的失败看起来就像刚刚发生的。
          (channel.notices ?? []).map((notice, index) => h('p', {
            className: `dcs_notice ${notice.level === 'warn' ? 'warn' : notice.level === 'info' ? 'info' : ''}`.trim(),
            key: `${notice.at}-${index}`,
          }, notice.message,
          h('span', { className: 'dcs_notice_time' }, ` · ${agoText(notice.at)}`))),
          // CodeArts 的免费额度同时是一个模型渠道：登录后模型会出现在选择器里。
          // 这条提示把两件事连起来，省得用户以为签到和模型是两套东西。
          channel.id === 'codearts' && total > 0
            ? h('p', { className: 'dcs_note' },
              '这个账号的免费额度已接入模型选择器（provider devcloud）：'
              + '直接选 GLM-5.2 / deepseek-v4 等即可，额度按 UTC+8 自然日重置。')
            : null,
          total === 0
            ? h('p', { className: 'dcs_note' }, `还没有账号。点右上角「添加账号」——${addHint}`)
            : channel.accounts.map(row => {
              const detail = detailOf(row)
              const busy = acting.startsWith(`${row.id}:`)
              return h('div', { className: 'dcs_row', key: row.id },
                h('div', { className: 'dcs_who' },
                  h('b', null,
                    row.nickname || '未命名账号',
                    row.duplicateOf === undefined
                      ? null
                      : h('span', { className: 'dcs_dup' }, '同一账号')),
                  h('span', null, row.id)),
                h(Badge, { state: row.state }),
                h('div', { className: 'dcs_msg' },
                  row.message ?? '',
                  row.enabled === false ? h('span', { className: 'dcs_off' }, '已停用') : null,
                  detail ? h('div', { className: 'dcs_dim' }, detail) : null,
                  creditLine(row) === '' ? null : h('div', { className: 'dcs_dim' }, creditLine(row)),
                  packageLine(row) === '' ? null : h('div', { className: 'dcs_dim' }, `积分包：${packageLine(row)}`),
                  // 同一份额度被登录了两次：说清「额度只算一次」，并给出怎么改。
                  row.duplicateOf === undefined
                    ? null
                    : h('div', { className: 'dcs_dim' },
                      `与 ${row.duplicateName ?? row.duplicateOf} 是同一个华为云账号，共用同一份额度（只算一次）；`
                      + '留一个即可，多余的可以点「退出」删掉。'),
                  typeof row.warning === 'string' && row.warning !== ''
                    ? h('div', { className: 'dcs_dim' }, row.warning)
                    : null),
                h('div', { className: 'dcs_rowacts' },
                  h('button', {
                    type: 'button', className: 'dcs_btn ghost',
                    disabled: busy,
                    onClick: () => onAct('toggle', channel, row),
                  }, row.enabled === false ? '启用' : '停用'),
                  h('button', {
                    type: 'button', className: 'dcs_btn ghost danger',
                    disabled: busy,
                    onClick: () => onAct('remove', channel, row),
                  }, busy ? '…' : '退出')))
            }),
          // 会话面板只对 CodeArts 有意义：并发上限只对模型调用生效。
          channel.id === 'codearts'
            ? h(SessionsBlock, {
              sessions,
              queue,
              onAbort: () => onAbortSessions(),
              onProbe: () => onProbeQueue(),
              busy: acting === 'sessions',
            })
            : null))
    }

    function SettingsPage() {
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState(false)
      const [claiming, setClaiming] = useState(false)
      const [result, setResult] = useState(null)
      const [error, setError] = useState(null)
      const [acting, setActing] = useState('')
      const [adding, setAdding] = useState('')
      const [notice, setNotice] = useState('')
      // 每添加一次自增一次：用来触发「等授权完成后自动刷新」的 effect。
      // 不能只依赖 notice 字符串——同一句文案不会让 React 重渲染。
      const [addSeq, setAddSeq] = useState(0)
      // 会话面板：本机在途流（服务端没有查询接口，只能管好自己发起的）。
      const [sessions, setSessions] = useState(null)
      const [queue, setQueue] = useState(null)

      /**
       * 读状态。
       *
       * 默认走服务端缓存（90 秒），进页面是瞬时的；`force` 用于「刷新」按钮——
       * 用户点刷新就是要看最新的，不能还给他缓存。
       */
      const load = useCallback(async force => {
        setBusy(true)
        setError(null)
        try {
          // `?refresh=1` 由服务端同时清掉旧提示（事件不该跟着刷新复活），
          // 这里不需要额外的清理请求。
          setState(await api(force === true ? '/status?refresh=1' : '/status'))
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => { void load(false) }, [load])

      /** 拉一次本机在途会话。失败只让面板停在旧值，不弹错——它只是观测面。 */
      const loadSessions = useCallback(async () => {
        try { setSessions(await api('/sessions')) } catch { /* 观测面掉线不影响签到 */ }
      }, [])

      useEffect(() => { void loadSessions() }, [loadSessions])

      // 8 秒一轮：够看到「在跑 / 结束」，又不至于把日志刷满。纯本地请求，不打上游。
      useEffect(() => {
        const timer = setInterval(() => { void loadSessions() }, 8000)
        return () => clearInterval(timer)
      }, [loadSessions])

      /** 终止本机所有在途流：断流即释放服务端的并发名额。 */
      const abortSessions = useCallback(async () => {
        setActing('sessions')
        setError(null)
        try {
          const res = await api('/sessions/abort', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
            timeout: 15_000,
          })
          if (res?.state) setSessions(res.state)
          else await loadSessions()
          setNotice(res?.aborted > 0 ? `已终止 ${res.aborted} 个在途请求，名额会立刻释放` : '当前没有在途请求')
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setActing('')
        }
      }, [loadSessions])

      /** 问一次服务端的排队状态（只读，一个签名 GET）。 */
      const probeQueue = useCallback(async () => {
        setActing('sessions')
        setError(null)
        try {
          const res = await api('/sessions?queue=1', { timeout: 20_000 })
          setSessions(res)
          setQueue(res?.queue ?? null)
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setActing('')
        }
      }, [])

      // 授权完成前账号只是占位（昵称等于 id）。后台轻量重试几次，
      // 让新账号自己冒出来——CodeArts 要用户去浏览器登录，可能花上一两分钟。
      useEffect(() => {
        if (addSeq === 0) return undefined
        const timers = [4000, 10000, 20000, 35000, 60000].map(delay =>
          setTimeout(() => { void load() }, delay))
        return () => { for (const timer of timers) clearTimeout(timer) }
      }, [addSeq, load])

      const claim = useCallback(async () => {
        setClaiming(true)
        setError(null)
        setResult(null)
        try {
          const res = await api('/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          setResult(res)
          // 刚签完必看最新：服务端已经失效缓存，这里再显式要一次刷新，避免读到你拿不到的旧快照。
          setState(await api('/status?refresh=1'))
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setClaiming(false)
        }
      }, [])

      const act = useCallback(async (kind, channel, row) => {
        const name = row.nickname || row.id
        if (kind === 'remove') {
          const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm(`退出账号「${name}」？\n\n这会同时删除本机保存的凭据：该账号的模型会立即不可用，且无法在签到页恢复（需要重新登录）。`)
            : false
          if (!confirmed) return
        }
        setActing(`${row.id}:${kind}`)
        setError(null)
        setNotice('')
        try {
          const res = await api(kind === 'remove' ? '/accounts/remove' : '/accounts/toggle', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(kind === 'remove'
              ? { channel: channel.id, accountId: row.id }
              : { channel: channel.id, accountId: row.id, enabled: row.enabled === false }),
            timeout: 120_000,
          })
          if (res?.state) setState(res.state)
          else await load()
          setNotice(kind === 'remove' ? `已退出「${name}」` : `已${row.enabled === false ? '启用' : '停用'}「${name}」`)
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setActing('')
        }
      }, [load])

      const add = useCallback(async channel => {
        if (adding !== '') return
        setAdding(channel.id)
        setError(null)
        setNotice('')
        // 先在点击手势里占一个空窗口：等 RPC 返回再 open 会被浏览器当弹窗拦掉。
        let popup = null
        try { popup = window.open('about:blank', '_blank') } catch { popup = null }
        try {
          const res = await api('/accounts/add', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ channel: channel.id }),
            timeout: 60_000,
          })
          const url = res?.loginUrl
          if (typeof url !== 'string' || url === '') throw new Error('服务端没有返回登录地址')
          if (popup !== null && !popup.closed) {
            try { popup.location.replace(url) } catch { window.open(url, '_blank', 'noopener') }
          } else {
            window.open(url, '_blank', 'noopener')
          }
          setNotice('已打开授权页：完成登录后账号会自动出现在列表里（授权窗口最多保留几分钟，超时请重试）。')
          setAddSeq(seq => seq + 1)
        } catch (e) {
          try { if (popup !== null && !popup.closed) popup.close() } catch { /* 关不掉就算了 */ }
          setError(String(e?.message ?? e))
        } finally {
          setAdding('')
        }
      }, [adding])

      const channels = state?.channels ?? []
      const claimable = channels.reduce((sum, c) => sum + (c.claimableCount ?? 0), 0)
      const checkedIn = channels.reduce((sum, c) => sum + (c.checkedInCount ?? 0), 0)
      const failed = channels.reduce((sum, c) => sum + (c.errorCount ?? 0), 0)

      return h('div', { className: 'dcs_root' },
        h('div', { className: 'dcs_head' },
          h('div', { className: 'dcs_titles' },
            h('h2', null, '每日签到'),
            h('p', { className: 'dcs_sub' }, '定时把 CodeBuddy、WorkBuddy、华为云 CodeArts 的每日签到跑掉；这里可以手动补签或查看结果。')),
          h('div', { className: 'dcs_pills' },
            state?.date ? h('span', { className: 'dcs_pill' }, state.date) : null,
            // 缓存读出来的快照要标时间：否则「数字怎么没变」会变成新的疑问。
            state === null
              ? null
              : h('span', { className: 'dcs_pill' },
                state.cached === true
                  ? `缓存 · ${Math.max(1, Math.round((state.ageMs ?? 0) / 1000))} 秒前`
                  : '刚刚更新'),
            state === null
              ? null
              : h('span', { className: 'dcs_pill' }, h(Dot, { tone: claimable > 0 ? 'warn' : 'ok' }), claimable > 0 ? `${claimable} 个待签` : '全部已签'),
            failed > 0 ? h('span', { className: 'dcs_pill' }, h(Dot, { tone: 'err' }), `${failed} 个异常`) : null)),

        h('div', { className: 'dcs_actions' },
          h('button', { type: 'button', className: 'dcs_btn primary', disabled: busy || claiming, onClick: claim }, claiming ? '签到中…' : '立即签到'),
          h('button', { type: 'button', className: 'dcs_btn ghost', disabled: busy || claiming, onClick: () => load(true) }, busy ? '刷新中…' : '刷新')),

        error ? h('div', { className: 'dcs_panel' }, h('p', { className: 'dcs_note dcs_err' }, error)) : null,
        notice ? h('div', { className: 'dcs_panel' }, h('p', { className: 'dcs_note' }, notice)) : null,

        result ? h('div', { className: 'dcs_panel' },
          h('p', { className: 'dcs_note' },
            `签到结果：新领 ${result.summary?.claimed ?? 0} 个，已签 ${result.summary?.alreadyClaimed ?? 0} 个，`
            + `无活动 ${result.summary?.inactive ?? 0} 个，失败 ${result.summary?.failed ?? 0} 个。`),
          (result.results ?? []).filter(row => row.kind === 'claimed' || row.kind === 'failed').map((row, i) =>
            h('p', { className: 'dcs_note', key: `${row.accountId}-${i}` },
              `${row.channelName} · ${row.nickname || row.accountId}：`,
              row.message ?? row.kind))) : null,

        state === null
          ? h('p', { className: 'dcs_note' }, '正在读取签到状态…')
          : channels.map(channel => h(ChannelCard, {
            key: channel.id,
            channel,
            onAct: act,
            onAdd: add,
            acting,
            adding,
            sessions: channel.id === 'codearts' ? sessions : null,
            queue: channel.id === 'codearts' ? queue : null,
            onAbortSessions: abortSessions,
            onProbeQueue: probeQueue,
          })),

        h('p', { className: 'dcs_note' }, '启动后会自动跑一轮；这里手动签到不会重复领取已完成的奖励。'))
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-codearts')
        style.textContent = CSS + CSS_EXTRA
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-codearts: styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-codearts',
        order: 37,
        label: () => '签到',
      }, () => h(SettingsPage)))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-codearts'
    return module.exports
  },
})

// ─────────────────────────────────────────────────────────────
// 此插件由 WorkBuddy 设计，并参考 Our Free Model 开发。
// ─────────────────────────────────────────────────────────────

