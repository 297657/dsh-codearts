/**
 * wbipc 命名管道客户端（WorkBuddy 桌面端内置的本地 RPC 通道）。
 *
 * 移植自 dsh-workbuddy/wb-client.mjs（同一份协议实现，v1.1：按 id 路由响应、
 * 遵守 max_inflight、断线重连、握手可重试），去掉 CLI 部分，只留库接口。
 *
 * 为什么必须走 wbipc 而不是直连 HTTPS：WorkBuddy 的 `/v2/chat/completions`
 * 有渠道校验（11128 request illegal），非官方客户端签名的请求一律被拒；
 * 只有经过桌面端注入身份头的 http.fetch 才被放行。
 */

import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const PROTOCOL_MIN = 1
const PROTOCOL_MAX = 1
const CONNECT_TIMEOUT_MS = 3000
const HANDSHAKE_TIMEOUT_MS = 5000
const RPC_TIMEOUT_MS = 30_000
const DEFAULT_MAX_INFLIGHT = 8

function endpointsPath() {
  const dir = process.env.WORKBUDDY_CONFIG_DIR?.trim() || path.join(os.homedir(), '.workbuddy')
  return path.join(dir, 'wbipc', 'endpoint.json')
}

function readDiscovery() {
  const file = endpointsPath()
  if (!fs.existsSync(file)) throw new Error(`E_NO_ENDPOINT: 找不到 ${file}，WorkBuddy 可能没在运行`)
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`E_BAD_ENDPOINT: ${file} 解析失败（${error.message}）`)
  }
  if (!cfg.endpoint || !cfg.ticket) throw new Error('E_BAD_ENDPOINT: endpoint.json 缺 endpoint/ticket')
  return cfg
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function ticketId(ticket) {
  return crypto.createHash('sha256').update(ticket, 'utf8').digest('hex').slice(0, 16)
}

/** transcript = 每段（uint32BE 长度 + UTF-8 字节）拼接。 */
function transcript(role, protocol, endpoint, clientNonce, serverNonce) {
  const parts = [
    role === 'server' ? 'wbipc-s' : 'wbipc-c',
    String(protocol),
    endpoint,
    clientNonce,
    serverNonce,
  ]
  const chunks = []
  for (const p of parts) {
    const b = Buffer.from(p, 'utf8')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(b.length, 0)
    chunks.push(len, b)
  }
  return Buffer.concat(chunks)
}

function proof(ticket, role, protocol, endpoint, clientNonce, serverNonce) {
  const msg = transcript(role, protocol, endpoint, clientNonce, serverNonce)
  return b64url(crypto.createHmac('sha256', Buffer.from(ticket, 'utf8')).update(msg).digest())
}

function safeEqual(a, b) {
  const ba = Buffer.from(a || '', 'utf8')
  const bb = Buffer.from(b || '', 'utf8')
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/** 换行分帧：JSON + "\n"。 */
function createFramer(onFrame, onError) {
  let buf = Buffer.alloc(0)
  const MAX = 8 * 1024 * 1024
  return chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    for (;;) {
      const idx = buf.indexOf(10)
      if (idx < 0) {
        if (buf.length > MAX) onError(new Error('E_FRAME_TOO_BIG'))
        return
      }
      const line = buf.subarray(0, idx)
      buf = buf.subarray(idx + 1)
      if (!line.length) continue
      let msg
      try {
        msg = JSON.parse(line.toString('utf8'))
      } catch {
        onError(new Error('E_MALFORMED_FRAME'))
        return
      }
      onFrame(msg)
    }
  }
}

export async function connect({ client = { kind: 'plugin', id: 'dsh-codearts', version: '1.0.0' } } = {}) {
  const { endpoint, ticket } = readDiscovery()

  const sock = net.connect({ path: endpoint })
  sock.setNoDelay(true)

  // 按 id 路由的待处理表：并发时响应可能乱序返回，FIFO 会丢帧
  const pending = new Map()
  const notifications = []
  let closed = false
  let closeError = null
  let seq = 1

  const settleAll = error => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  const onFrame = msg => {
    if (msg && msg.id !== undefined && msg.id !== null) {
      const entry = pending.get(msg.id)
      if (entry) {
        pending.delete(msg.id)
        clearTimeout(entry.timer)
        entry.onSettle()
        if (msg.error) {
          const err = new Error(`${msg.error.code ?? 'E_RPC'}: ${msg.error.message ?? 'unknown'}`)
          err.code = msg.error.code
          err.data = msg.error.data
          entry.reject(err)
        } else {
          entry.resolve(msg.result)
        }
        return
      }
      return
    }
    notifications.push(msg)
    if (notifications.length > 32) notifications.shift()
  }

  // 握手帧与业务帧共用一条 socket，用一个开关分流，避免开两个解析器
  let inHandshake = true
  const handshakeFrames = []
  const handshakeWaiters = []

  const routeFrame = msg => {
    if (!inHandshake) {
      onFrame(msg)
      return
    }
    const w = handshakeWaiters.shift()
    if (w) {
      clearTimeout(w.timer)
      w.resolve(msg)
      return
    }
    handshakeFrames.push(msg)
  }

  const framer = createFramer(routeFrame, e => sock.destroy(e))
  sock.on('data', framer)
  sock.on('error', e => {
    closed = true
    closeError = e
    settleAll(e)
  })
  sock.on('close', () => {
    closed = true
    const err = closeError ?? new Error('E_CLOSED: 连接已断开（WorkBuddy 可能重启了，需重新读 endpoint.json）')
    settleAll(err)
  })

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('E_CONNECT_TIMEOUT')), CONNECT_TIMEOUT_MS)
    sock.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
    sock.once('error', e => {
      clearTimeout(timer)
      reject(e)
    })
  })

  const send = msg => {
    if (closed) throw closeError ?? new Error('E_CLOSED')
    sock.write(JSON.stringify(msg) + '\n')
  }

  const nextHandshake = (timeout = HANDSHAKE_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      if (handshakeFrames.length) return resolve(handshakeFrames.shift())
      const timer = setTimeout(() => {
        const i = handshakeWaiters.findIndex(w => w.timer === timer)
        if (i >= 0) handshakeWaiters.splice(i, 1)
        reject(new Error('E_TIMEOUT: 握手超时'))
      }, timeout)
      handshakeWaiters.push({ resolve, reject, timer })
    })

  const clientNonce = b64url(crypto.randomBytes(16))
  send({
    type: 'session_hello',
    protocol_min: PROTOCOL_MIN,
    protocol_max: PROTOCOL_MAX,
    client_nonce: clientNonce,
    ticket_id: ticketId(ticket),
    client,
  })

  let challenge
  for (;;) {
    const f = await nextHandshake()
    if (f.type === 'session_hello_error') {
      sock.destroy()
      const err = new Error(`E_HELLO_REJECTED: ${f.code ?? 'unknown'}`)
      err.code = f.code
      throw err
    }
    if (f.type === 'session_challenge') {
      challenge = f
      break
    }
  }

  const protocol = challenge.protocol ?? PROTOCOL_MIN
  const serverNonce = challenge.server_nonce
  if (!serverNonce) {
    sock.destroy()
    throw new Error('E_BAD_CHALLENGE: 缺 server_nonce')
  }

  const expect = proof(ticket, 'server', protocol, endpoint, clientNonce, serverNonce)
  if (!safeEqual(expect, challenge.server_proof)) {
    sock.destroy()
    throw new Error('E_ENDPOINT_UNTRUSTED: server_proof 不匹配，端点可能是伪造的')
  }

  send({
    type: 'session_prove',
    client_proof: proof(ticket, 'client', protocol, endpoint, clientNonce, serverNonce),
  })

  let ack
  for (;;) {
    const f = await nextHandshake()
    if (f.type === 'session_hello_error') {
      sock.destroy()
      const err = new Error(`E_HANDSHAKE_REJECTED: ${f.code ?? 'unknown'}`)
      err.code = f.code
      throw err
    }
    if (f.type === 'session_hello_ack') {
      ack = f
      break
    }
  }

  inHandshake = false

  const pipes = (ack.pipes ?? []).map(p => (typeof p === 'string' ? p : p?.name)).filter(Boolean)
  const maxInflight = Number(ack.max_inflight) > 0 ? Number(ack.max_inflight) : DEFAULT_MAX_INFLIGHT
  const channels = new Map()

  // 并发闸门：超过 max_inflight 排队，避免宿主侧背压
  let inflight = 0
  const gate = []

  const acquire = () =>
    new Promise(resolve => {
      if (inflight < maxInflight) {
        inflight += 1
        resolve()
        return
      }
      gate.push(resolve)
    })

  const release = () => {
    const next = gate.shift()
    if (next) {
      next()
      return
    }
    inflight -= 1
  }

  function rpcRaw(method, params = {}, { mode, timeout = RPC_TIMEOUT_MS } = {}) {
    const id = seq++
    const frame = { jsonrpc: '2.0', id, method, params }
    if (mode) frame.mode = mode
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(closeError ?? new Error('E_CLOSED'))
        return
      }
      const timer = setTimeout(() => {
        pending.delete(id)
        const err = new Error(`E_TIMEOUT: ${method} 超过 ${timeout}ms 未响应`)
        err.code = 'E_TIMEOUT'
        reject(err)
      }, timeout)
      pending.set(id, { resolve, reject, timer, onSettle: () => {} })
      try {
        send(frame)
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })
  }

  async function rpc(method, params = {}, options = {}) {
    await acquire()
    try {
      return await rpcRaw(method, params, options)
    } finally {
      release()
    }
  }

  async function bind(pipeName) {
    if (channels.has(pipeName)) return channels.get(pipeName)
    if (pipes.length && !pipes.includes(pipeName)) {
      const err = new Error(`E_CONSENT_REQUIRED: ${pipeName} 不在可见管道里，可见：${pipes.join(', ')}`)
      err.code = 'E_CONSENT_REQUIRED'
      throw err
    }
    const bound = await rpc('broker/GetPipe', { pipe: pipeName })
    const channel = bound.channel
    if (!channel) throw new Error('E_BIND_FAILED: 没有拿到 channel')
    channels.set(pipeName, channel)
    return channel
  }

  return {
    endpoint,
    protocol,
    clientId: ack.client_id ?? null,
    connectionEpoch: ack.connection_epoch ?? null,
    maxInflight,
    pipes,
    notifications,
    rpc,
    bind,
    get closed() {
      return closed
    },
    async call(pipeName, method, params = {}, options = {}) {
      const channel = await bind(pipeName)
      return rpc(`${channel}/${method}`, params, { mode: 'call', ...options })
    },
    close() {
      try {
        inHandshake = false
        sock.end()
      } catch { /* 已关闭 */ }
      settleAll(new Error('E_CLOSED'))
    },
  }
}
