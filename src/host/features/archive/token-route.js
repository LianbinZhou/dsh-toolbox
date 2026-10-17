/**
 * S4-c · the token endpoint (Pi's plan A).
 *
 * The delete route already refuses without a per-process token. This is how the
 * UI gets that token without handing it to anything else:
 *
 *   GET /api/archive-manager/token
 *
 * Same-origin only (no CORS headers at all, so a foreign page can send the
 * request but cannot read the body), `Cache-Control: no-store`, no side effects,
 * the same Host allowlist and X-Forwarded-* refusal as the delete route, and the
 * token travels in the JSON body — never a URL, never a log line.
 *
 * It issues a credential. It never deletes anything.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

export const TOKEN_PATH = '/api/archive-manager/token'

const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip']
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Constant-time token comparison that never throws.
 *
 * Length is compared first: `timingSafeEqual` throws when the buffers differ in
 * length, and a thrown exception on a bad token is both noisy and a timing leak.
 * @param {unknown} candidate
 * @param {unknown} expected
 * @returns {boolean}
 */
export function sameToken(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false
  const left = Buffer.from(candidate, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) return false
  try {
    return timingSafeEqual(left, right)
  } catch (error) {
    return false
  }
}

/**
 * One credential per process. `rotate()` is what a restart does.
 * @param {string} [token] - fixed token for tests; a random one otherwise
 */
export function createTokenRegistry(token) {
  let current = typeof token === 'string' && token.length >= 32 ? token : randomBytes(32).toString('hex')
  return {
    current: () => current,
    rotate() {
      current = randomBytes(32).toString('hex')
      return current
    },
    matches(candidate) {
      return sameToken(candidate, current)
    },
  }
}

function respond(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...extraHeaders,
    // Deliberately no Access-Control-Allow-*: a foreign page may send the request
    // but must not be able to read the answer.
  })
  res.end(text)
}

/**
 * Build the request handler.
 * @param {object} options
 * @param {object} options.registry - from createTokenRegistry
 * @param {string[]} [options.origins] - extra allowed origins (the real ones)
 * @param {boolean} [options.trustProxy]
 */
export function createTokenEndpoint({ registry, origins = [], trustProxy = false } = {}) {
  if (!registry || typeof registry.current !== 'function') {
    throw new TypeError('dsh-toolbox: createTokenEndpoint needs a token registry')
  }
  const configured = new Set(origins.map((value) => { try { return new URL(value).origin } catch (e) { return null } }).filter(Boolean))

  function allowedHosts(req) {
    const hosts = new Set([...configured].map((origin) => new URL(origin).host))
    // The port we actually bound is authoritative too: a test server binds an
    // ephemeral port and must still be reachable from its own origin.
    const local = req.socket && req.socket.localPort
    if (Number.isFinite(local)) {
      hosts.add('127.0.0.1:' + local)
      hosts.add('localhost:' + local)
      hosts.add('[::1]:' + local)
    }
    return hosts
  }

  return function handleToken(req, res) {
    const method = String(req.method || 'GET').toUpperCase()
    const headers = req.headers || {}

    if (!trustProxy && PROXY_HEADERS.some((name) => headers[name] !== undefined)) {
      respond(res, 403, { ok: false, error: 'proxied request refused' })
      return
    }
    if (method !== 'GET') {
      respond(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const host = typeof headers.host === 'string' ? headers.host.toLowerCase() : ''
    if (!allowedHosts(req).has(host)) {
      respond(res, 403, { ok: false, error: 'unexpected host' })
      return
    }
    if (headers.origin !== undefined) {
      let normalized = null
      try {
        normalized = new URL(String(headers.origin)).origin
      } catch (error) {
        normalized = null
      }
      if (normalized === null || !configured.has(normalized)) {
        respond(res, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
    }
    respond(res, 200, { ok: true, token: registry.current() })
  }
}

/** Is this request loopback? Exported so the guard can share one definition. */
export function isLoopback(peer) {
  return typeof peer === 'string' && LOOPBACK.has(peer)
}
