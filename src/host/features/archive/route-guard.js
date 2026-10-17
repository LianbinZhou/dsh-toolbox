/**
 * S4-b · the archive delete route, guarded.
 *
 * Pi's R0: `/api/archive-manager/delete` was a plain `webServer.register` exact
 * route with **no authentication at all** — exact routes are matched before the
 * API gateway, so a LAN client or a malicious page could physically delete
 * sessions with one simple POST. This module is the answer.
 *
 * Defence in depth, cheapest first:
 *
 *   1. loopback peer only            (a LAN client never reaches the handler)
 *   2. POST only; OPTIONS → 204      (no method confusion, no CORS surface)
 *   3. custom header required        (a browser simple request cannot set it)
 *   4. Origin, when present, must be same-origin (blocks a foreign page)
 *   5. Content-Type must be JSON     (text/plain would skip the preflight)
 *   6. body cap 64 KB                (streamed; over-cap chunks are dropped)
 *   7. sessionId re-validated with the paths allowlist
 *   8. error responses carry no absolute path, stack or internal detail
 *
 * The handler is transport-only: it never decides WHAT may be deleted. That
 * belongs to the service layer (R4/R5).
 */

import { createServer } from 'node:http'
import { isSafeSessionId } from './paths.js'

export const DELETE_PATH = '/api/archive-manager/delete'
export const MAX_BODY_BYTES = 64 * 1024
/** A header a browser simple request cannot set: it forces a preflight. */
export const CSRF_HEADER = 'x-dsh-toolbox'
/** The only client this route trusts. */
export const CSRF_VALUE = '1'

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** @param {string|undefined} peer - `req.socket.remoteAddress` */
export function isLoopbackPeer(peer) {
  return typeof peer === 'string' && LOOPBACK_PEERS.has(peer)
}

/**
 * Same-origin check by Host comparison.
 *
 * The server's listening port is dynamic, so comparing against a hardcoded
 * origin is impossible; the request's own Host header is the authority it must
 * match. An absent Origin is allowed because step 3 has already proven this is
 * not a simple request.
 * @param {string|undefined} origin - the Origin header
 * @param {string|undefined} host - the Host header
 */
export function isSameOrigin(origin, host) {
  if (origin === undefined) return true
  if (typeof origin !== 'string' || origin.length === 0) return false
  if (typeof host !== 'string' || host.length === 0) return false
  try {
    return new URL(origin).host === host
  } catch (error) {
    return false
  }
}

/** Is the declared body type JSON? `application/json; charset=utf-8` accepted. */
export function isJsonContentType(value) {
  if (typeof value !== 'string') return false
  return value.split(';')[0].trim().toLowerCase() === 'application/json'
}

/**
 * Decide whether this request may reach the handler.
 * @param {{method?: string, headers?: object, peer?: string}} request
 * @returns {{ok: true}|{ok: false, status: number, error: string}}
 */
export function authorizeRequest(request) {
  const method = String(request.method || 'GET').toUpperCase()
  const headers = request.headers || {}

  if (!isLoopbackPeer(request.peer)) {
    return { ok: false, status: 403, error: 'local access only' }
  }
  if (method === 'OPTIONS') {
    return { ok: true, preflight: true }
  }
  if (method !== 'POST') {
    return { ok: false, status: 405, error: 'method not allowed' }
  }
  if (String(headers[CSRF_HEADER] ?? '') !== CSRF_VALUE) {
    return { ok: false, status: 403, error: 'missing client header' }
  }
  if (!isSameOrigin(headers.origin, headers.host)) {
    return { ok: false, status: 403, error: 'cross-origin request refused' }
  }
  if (!isJsonContentType(headers['content-type'])) {
    return { ok: false, status: 415, error: 'content type must be application/json' }
  }
  const declared = Number(headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'body too large' }
  }
  return { ok: true }
}

/** One JSON answer. Never includes a path or a stack. */
function respond(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    // No CORS headers: nothing outside this origin may read the answer.
  })
  res.end(text)
}

/**
 * Build the guarded HTTP server.
 *
 * @param {object} options
 * @param {(sessionId: string) => (Promise<object>|object)} options.onDelete -
 *        the service call; the handler only validates and translates its result
 * @param {(req: object) => string|undefined} [options.peerOf] - injectable for tests
 * @returns {import('node:http').Server}
 */
export function createArchiveServer({ onDelete, peerOf } = {}) {
  const peer = peerOf || ((req) => req.socket && req.socket.remoteAddress)
  return buildServer(peer, onDelete)
}

function buildServer(peerOf, onDelete) {
  return createServer((req, res) => {
    const decision = authorizeRequest({
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
      respond(res, decision.status, { ok: false, error: decision.error })
      // Drain so the connection can be reused; the body is never buffered.
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
          const body = result && typeof result === 'object' ? result : { ok: true }
          // Only the fields the UI needs; never the reason a path failed.
          respond(res, body.ok === false ? 409 : 200, {
            ok: body.ok !== false,
            removedDir: body.removedDir === true,
            ...(typeof body.error === 'string' ? { error: body.error } : {}),
            ...(typeof body.warning === 'string' ? { warning: body.warning } : {}),
          })
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
  })
}
