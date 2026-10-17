/**
 * S4-c · the two routes the panel needs beyond `delete`.
 *
 * The old panel used list / unarchive / delete. The container only had delete, so
 * migrating the UI would have produced a panel that cannot show anything. These
 * routes are the smallest set that keeps the panel whole.
 *
 * They share the delete route's transport rules exactly: same token header, same
 * Host allowlist, same no-CORS posture, same JSON-only body, same size cap. Only
 * the action differs.
 */

import { CSRF_HEADER, CSRF_VALUE, MAX_BODY_BYTES, TOKEN_HEADER } from './route-guard.js'

export const LIST_PATH = '/api/archive-manager/list'
export const UNARCHIVE_PATH = '/api/archive-manager/unarchive'

function respond(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readJsonBody(req, res, done) {
  const chunks = []
  let size = 0
  let over = false
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      over = true
      return
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
    done(parsed)
  })
}

/**
 * Build the list and unarchive handlers on top of one guard.
 * @param {object} options
 * @param {object} options.guard - createRouteGuard result
 * @param {(peer: object) => object} options.peerOf
 * @param {object} options.api - { list, unarchive } from the host
 */
export function createApiHandlers({ guard, peerOf, api }) {
  function authorize(req, res) {
    const decision = guard.authorize({ method: req.method, headers: req.headers, peer: peerOf(req) })
    if (decision.ok && decision.preflight) {
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return false
    }
    if (!decision.ok) {
      respond(res, decision.status, { ok: false, error: decision.code })
      req.resume()
      return false
    }
    return true
  }

  return {
    /** GET: the archived rows the panel shows. */
    list(req, res) {
      if (!authorize(req, res)) return
      if (String(req.method || '').toUpperCase() !== 'GET') {
        respond(res, 405, { ok: false, error: 'method not allowed' })
        req.resume()
        return
      }
      const wantsDebug = String(req.url || '').includes('debug=1')
      Promise.resolve()
        .then(() => api.list())
        .then((result) => {
          const rows = Array.isArray(result?.rows) ? result.rows.slice(0, 500) : []
          respond(res, 200, wantsDebug && typeof api.debug === 'function' ? { ok: true, rows, debug: api.debug() } : { ok: true, rows })
        })
        .catch((error) => {
          console.error('[dsh-toolbox] archive list failed', error)
          respond(res, 500, { ok: false, error: 'list failed' })
        })
    },

    /** POST: undo the archive flag for one id. */
    unarchive(req, res) {
      if (!authorize(req, res)) return
      readJsonBody(req, res, (parsed) => {
        if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) {
          respond(res, 400, { ok: false, error: 'invalid sessionId' })
          return
        }
        Promise.resolve()
          .then(() => api.unarchive(parsed.sessionId))
          .then((result) => {
            const value = result && typeof result === 'object' ? result : {}
            const ok = value.ok !== false
            respond(res, ok ? 200 : 409, ok ? { ok: true } : { ok: false, error: 'unarchive refused' })
          })
          .catch((error) => {
            console.error('[dsh-toolbox] archive unarchive failed', error)
            respond(res, 500, { ok: false, error: 'unarchive failed' })
          })
      })
    },
  }
}

/** Exported so the guard tests can assert the shared header contract. */
export const API_HEADERS = Object.freeze({ CSRF_HEADER, CSRF_VALUE, TOKEN_HEADER })
