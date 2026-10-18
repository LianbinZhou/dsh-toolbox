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

import { toWireReason } from '../../../shared/reasons.js'
import { CSRF_HEADER, CSRF_VALUE, MAX_BODY_BYTES, TOKEN_HEADER } from './route-guard.js'

export const LIST_PATH = '/api/archive-manager/list'
export const TRASH_PATH = '/api/archive-manager/trash'
export const RESTORE_PATH = '/api/archive-manager/restore'
export const PURGE_PATH = '/api/archive-manager/purge'
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

  /** 回收箱相关的三条：查看、恢复、彻底清空。 */
  function trashCommon(req, res, run) {
    if (!authorize(req, res)) return
    Promise.resolve()
      .then(run)
      .then((result) => {
        const value = result && typeof result === 'object' ? result : {}
        const ok = value.ok !== false
        // 只回白名单字段：绝不带 trashPath / originalPath / nonce。
        const body = { ok }
        if (Array.isArray(value.rows)) {
          body.rows = value.rows.map((row) => ({
            id: row.id,
            phase: row.phase,
            keptDays: row.keptDays,
            at: row.at,
          }))
        }
        if (typeof value.protectedCount === 'number') body.protectedCount = value.protectedCount
        if (typeof value.keptDays === 'number') body.keptDays = value.keptDays
        if (typeof value.maxProtected === 'number') body.maxProtected = value.maxProtected
        // 警告也是稳定码（cleanup-pending 等），同样要过共享表。
        if (typeof value.warning === 'string') body.warning = toWireReason(value.warning)
        // 与删除同一条规则：内部码必须经过共享表，不能原样出网。
        if (!ok) body.reason = toWireReason(value.reason)
        respond(res, ok ? 200 : 409, body)
      })
      .catch((error) => {
        console.error('[dsh-toolbox] 回收箱操作失败', error)
        respond(res, 500, { ok: false, reason: 'request-failed' })
      })
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

    /** GET：回收箱列表（不含路径与 nonce）。 */
    trash(req, res) {
      if (String(req.method || '').toUpperCase() !== 'GET') {
        respond(res, 405, { ok: false, error: 'method not allowed' })
        req.resume()
        return
      }
      trashCommon(req, res, () => api.trash())
    },

    /** POST：把垃圾桶里的会话放回原位。 */
    restore(req, res) {
      if (String(req.method || '').toUpperCase() !== 'POST') {
        respond(res, 405, { ok: false, error: 'method not allowed' })
        req.resume()
        return
      }
      if (!authorize(req, res)) return
      readJsonBody(req, res, (parsed) => {
        const id = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
        trashCommon(req, res, () => api.restore(id))
      })
    },

    /** POST：彻底清空一条（必须显式 confirm）。 */
    purge(req, res) {
      if (String(req.method || '').toUpperCase() !== 'POST') {
        respond(res, 405, { ok: false, error: 'method not allowed' })
        req.resume()
        return
      }
      if (!authorize(req, res)) return
      readJsonBody(req, res, (parsed) => {
        if (parsed.confirm !== true) {
          respond(res, 400, { ok: false, error: 'confirm required', reason: 'confirm-required' })
          return
        }
        const id = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
        trashCommon(req, res, () => api.purge(id))
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
