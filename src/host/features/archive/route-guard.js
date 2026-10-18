/**
 * S4-b · the archive delete route, guarded.
 *
 * Pi 的 R0 复核打穿了三层，这里逐条重写：
 *
 *   P0-1 同源不能拿请求里的 Host 当权威 —— 那就等于让攻击者自己签通行证。
 *        改为**本地真实监听的 origin 白名单**（`createArchiveServer` 从
 *        `server.address()` 推导；宿主挂载时由调用方显式给 `origins`）。
 *        Host 也必须落在这个白名单里，所以 DNS rebinding 后 `Host: evil.example`
 *        直接被拒。
 *   P0-2 loopback 不是认证 —— 前面挂个反向代理，所有远程请求的 remoteAddress
 *        都是 127.0.0.1。带 `X-Forwarded-For` / `Forwarded` 的请求一律拒绝，
 *        除非显式 `trustProxy: true`。
 *   P0-3 常量头不是认证 —— 只当 CSRF 预检触发器（浏览器简单请求设不了自定义头）。
 *        真正的凭证是**每进程随机 token**（`TOKEN_HEADER`），未配置 token 时
 *        一律 fail closed。
 *
 * 另外两条 P1：
 *   P1-5 错误响应脱敏：service 的 `error` / `warning` 原文**永不**回传客户端。
 *   P1-6 同一份 handler 同时用于独立靶场和宿主 `webServer.register` 挂载，
 *        避免"测的不是生效的那份"。
 *
 * 这个 handler 只做传输层门卫，不决定"能不能删"（那是服务层 R4/R5 的事）。
 */

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { isSafeSessionId } from './paths.js'
import { sameToken } from './token-route.js'

export const DELETE_PATH = '/api/archive-manager/delete'
export const MAX_BODY_BYTES = 64 * 1024
/** Forces a preflight; it is NOT a credential. */
export const CSRF_HEADER = 'x-dsh-toolbox'
export const CSRF_VALUE = '1'
/** The actual credential: a per-process random value. */
export const TOKEN_HEADER = 'x-dsh-toolbox-token'

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip']

/** @param {string|undefined} peer */
export function isLoopbackPeer(peer) {
  return typeof peer === 'string' && LOOPBACK_PEERS.has(peer)
}

/** Full origin (`scheme://host:port`), or null when unparsable. */
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    return new URL(value).origin
  } catch (error) {
    return null
  }
}

/** Is the declared body type JSON? `application/json; charset=utf-8` accepted. */
export function isJsonContentType(value) {
  if (typeof value !== 'string') return false
  return value.split(';')[0].trim().toLowerCase() === 'application/json'
}

/** A fresh per-process credential. */
export function createRouteToken() {
  return randomBytes(32).toString('hex')
}

/**
 * Build one guard bound to a FIXED origin allowlist and one token.
 *
 * @param {object} options
 * @param {string[]} options.allowedOrigins - the origins this server really
 *        listens on. NEVER derived from an incoming request.
 * @param {string} options.token - the credential a caller must present
 * @param {boolean} [options.trustProxy] - accept proxy headers (only when a
 *        trusted local proxy is configured)
 */
export function createRouteGuard({ allowedOrigins = [], token, trustProxy = false, methods = ['POST'] } = {}) {
  const allowed = new Set((Array.isArray(methods) ? methods : ['POST']).map((m) => String(m).toUpperCase()))
  const origins = new Set(allowedOrigins.map(normalizeOrigin).filter(Boolean))
  const hosts = new Set([...origins].map((origin) => new URL(origin).host))

  /**
   * @param {{method?: string, headers?: object, peer?: string}} request
   * @returns {{ok: true, preflight?: boolean}|{ok: false, status: number, code: string}}
   */
  function authorize(request) {
    const method = String(request.method || 'GET').toUpperCase()
    const headers = request.headers || {}
    const refuse = (status, code) => ({ ok: false, status, code })

    // P0-2: a proxied request looks like loopback and is not.
    if (!trustProxy && PROXY_HEADERS.some((name) => headers[name] !== undefined)) {
      return refuse(403, 'proxied request refused')
    }
    if (!isLoopbackPeer(request.peer)) {
      return refuse(403, 'local access only')
    }
    if (method === 'OPTIONS') {
      return { ok: true, preflight: true }
    }
    if (!allowed.has(method)) {
      return refuse(405, 'method not allowed')
    }

    // P0-1: the Host must be one we actually listen on. This is what stops DNS
    // rebinding: after a rebind the browser still sends `Host: evil.example`.
    if (origins.size === 0) {
      return refuse(403, 'no allowed origins configured')
    }
    const host = typeof headers.host === 'string' ? headers.host.toLowerCase() : ''
    if (!hosts.has(host)) {
      return refuse(403, 'unexpected host')
    }

    // P1-7: a full origin comparison (scheme + host + port), not just the host.
    const origin = headers.origin
    if (origin !== undefined) {
      const normalized = normalizeOrigin(origin)
      if (normalized === null || !origins.has(normalized)) {
        return refuse(403, 'cross-origin request refused')
      }
    }

    // P0-3: the real credential.
    if (typeof token !== 'string' || token.length < 32) {
      return refuse(401, 'route has no credential configured')
    }
    // Length-first constant-time comparison: `timingSafeEqual` throws when the
    // buffers differ in length, so a short or missing token must be rejected
    // before it can reach crypto.
    if (!sameToken(headers[TOKEN_HEADER], token)) {
      return refuse(401, 'missing or invalid token')
    }

    // A GET has no body, so demanding JSON would reject every read-only call.
    // Only methods that carry a body are held to the type rule.
    if (method !== 'GET' && method !== 'HEAD' && !isJsonContentType(headers['content-type'])) {
      return refuse(415, 'content type must be application/json')
    }
    const declared = Number(headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return refuse(413, 'body too large')
    }
    return { ok: true }
  }

  return { authorize, allowedOrigins: [...origins], hosts: [...hosts], hasToken: typeof token === 'string' && token.length >= 32 }
}

/** One JSON answer. Only whitelisted fields; never a service message. */
function respond(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    // No CORS headers by design: nothing outside this origin may read the answer.
  })
  res.end(text)
}

/**
 * The ONE delete handler used by both the standalone port and the host mount.
 *
 * @param {object} options
 * @param {{authorize: Function}} options.guard
 * @param {(sessionId: string) => (Promise<object>|object)} options.onDelete
 * @param {() => string|undefined} options.peerOf
 * @returns {(req: object, res: object) => void}
 */
export function createDeleteHandler({ guard, onDelete, peerOf }) {
  return function handleDelete(req, res) {
    const decision = guard.authorize({
      method: req.method,
      headers: req.headers,
      peer: peerOf(req),
    })

    if (decision.ok && decision.preflight) {
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (!decision.ok) {
      respond(res, decision.status, { ok: false, error: decision.code })
      req.resume()
      return
    }

    const chunks = []
    let size = 0
    let over = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        over = true
        return // drop it: memory stays bounded even for a hostile body
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (over) {
        respond(res, 413, { ok: false, error: 'body too large' })
        return
      }
      let parsed
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch (error) {
        respond(res, 400, { ok: false, error: 'bad json' })
        return
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        respond(res, 400, { ok: false, error: 'body must be an object' })
        return
      }
      if (typeof parsed.sessionId !== 'string' || !isSafeSessionId(parsed.sessionId)) {
        respond(res, 400, { ok: false, error: 'invalid sessionId' })
        return
      }

      Promise.resolve()
        .then(() => (typeof onDelete === 'function' ? onDelete(parsed.sessionId) : { ok: true }))
        .then((result) => {
          const value = result && typeof result === 'object' ? result : {}
          const ok = value.ok !== false
          // P1-5: never pass the service message through — it may contain an
          // absolute path, a stack, or a hint about the filesystem layout.
          // 说清楚它去了哪儿、能不能捞回来、保留多久——白名单三个字段，
        // 绝不透传服务层的路径或错误原文。
        const body = {
          ok,
          removedDir: value.removedDir === true,
          movedToTrash: value.movedToTrash === true,
          recoverable: value.recoverable === true,
          keptDays: Number.isFinite(value.keptDays) ? value.keptDays : undefined,
        }
          if (!ok) body.error = 'delete refused'
          else if (value.warning !== undefined) body.warning = 'deleted with warnings'
          respond(res, ok ? 200 : 409, body)
        })
        .catch(() => {
          respond(res, 500, { ok: false, error: 'delete failed' })
        })
    })
    req.on('error', () => {
      try {
        respond(res, 400, { ok: false, error: 'bad request' })
      } catch (error) {
        /* the socket is already gone */
      }
    })
  }
}

/**
 * Standalone guarded port (used by the attack matrix).
 *
 * The origin allowlist is derived from the address the server REALLY bound to,
 * never from a request header. A token is generated unless one is passed.
 *
 * @param {object} options
 * @param {(id: string) => object} options.onDelete
 * @param {string} [options.token]
 * @param {number[]} [options.extraPorts] - extra ports to accept (tunnels)
 */
export function createArchiveServer({ onDelete, token, extraPorts = [], trustProxy = false } = {}) {
  const secret = token || createRouteToken()
  let guard = null

  const server = createServer((req, res) => {
    if (guard === null) {
      guard = createRouteGuard({ allowedOrigins: originsFor(server, extraPorts), token: secret, trustProxy })
    }
    createDeleteHandler({ guard, onDelete, peerOf: (r) => r.socket && r.socket.remoteAddress })(req, res)
  })

  server.dshToolboxToken = secret
  return server
}

/** The origins this server actually listens on (all loopback spellings). */
function originsFor(server, extraPorts = []) {
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : undefined
  if (port === undefined) return []
  const origins = [
    'http://127.0.0.1:' + port,
    'http://localhost:' + port,
    'http://[::1]:' + port,
  ]
  for (const extra of extraPorts) {
    if (Number.isFinite(extra)) {
      origins.push('http://127.0.0.1:' + extra, 'http://localhost:' + extra, 'http://[::1]:' + extra)
    }
  }
  return origins
}

/**
 * Mount the route on the host's web server (P1-6: the same handler the matrix
 * exercises, so "what is tested" and "what runs" cannot drift).
 *
 * FAIL CLOSED: without an explicit origin list and a token, nothing is
 * registered at all.
 *
 * @param {object} options
 * @param {{register: Function}} options.webServer
 * @param {(id: string) => object} options.onDelete
 * @param {string} options.token
 * @param {string[]} options.origins - the REAL origins this host serves
 * @param {boolean} [options.trustProxy]
 * @returns {{registered: boolean, reason?: string, dispose?: Function, token: string}}
 */
export function registerArchiveRoutes({ webServer, onDelete, token, origins, trustProxy = false, enabled = false } = {}) {
  // The HTTP route is a BELT, not the plan: the UI uses the authenticated RPC
  // channel. Mounting is therefore opt-in, and forgetting the flag keeps the
  // endpoint closed rather than open.
  if (enabled !== true) {
    return { registered: false, reason: 'http route disabled by configuration', token: token || '' }
  }
  if (!webServer || typeof webServer.register !== 'function') {
    return { registered: false, reason: 'no web server', token: token || '' }
  }
  if (typeof token !== 'string' || token.length < 32) {
    return { registered: false, reason: 'no route token configured', token: token || '' }
  }
  if (!Array.isArray(origins) || origins.length === 0) {
    return { registered: false, reason: 'no allowed origins configured', token }
  }

  const guard = createRouteGuard({ allowedOrigins: origins, token, trustProxy })
  const handler = createDeleteHandler({
    guard,
    onDelete,
    peerOf: (req) => req.socket && req.socket.remoteAddress,
  })

  const route = { kind: 'exact', method: 'POST', path: DELETE_PATH, handler }
  const disposer = webServer.register(route)
  return {
    registered: true,
    token,
    guard,
    dispose: typeof disposer === 'function' ? disposer : () => {},
  }
}
