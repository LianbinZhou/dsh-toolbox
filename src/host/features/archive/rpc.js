/**
 * S4-b · the RPC channel: the PREFERRED way for the UI to delete.
 *
 * Pi's correction is baked into the wording and the code: this is **not** a zero
 * attack surface. It removes the extra UNAUTHENTICATED endpoint; the surface
 * moves to DSH's authenticated RPC gateway plus **method-level authorization**,
 * which is exactly what this module adds:
 *
 *   principal -> authorize(action, id, principal) -> rate limit -> service
 *             -> response whitelist -> audit(actor)
 *
 * Rejections are codes, never messages. Responses are whitelisted, so a service
 * that returns `C:\secret\path` cannot leak it to the client.
 */

import { isSafeSessionId } from './paths.js'
import { pick } from './audit.js'

/** Method names, so the gateway and the authorizer agree on one vocabulary. */
export const METHODS = {
  DELETE: 'archive.delete',
  RESTORE: 'archive.restore',
  LIST: 'archive.list',
  HEAL: 'archive.heal',
}

/** Fields a response may carry. Everything else a service returns is dropped. */
const RESPONSE_FIELDS = ['ok', 'status', 'reason', 'removedDir', 'restored', 'warning', 'rows']
/** P2-11: a list response is capped so one call cannot return the whole history. */
export const MAX_ROWS = 500

export function pickResponse(result) {
  if (!result || typeof result !== 'object') return { ok: false, status: 500, reason: 'internal-error' }
  const safe = {}
  for (const field of RESPONSE_FIELDS) {
    if (result[field] === undefined) continue
    safe[field] = field === 'rows' && Array.isArray(result[field]) ? result[field].slice(0, MAX_ROWS) : result[field]
  }
  if (safe.ok === undefined) safe.ok = false
  return safe
}

/**
 * @param {object} options
 * @param {object} options.service - createArchiveService(...) result
 * @param {(principal: object, action: string, id?: string) => boolean} [options.authorize]
 *        method-level authorization; when absent, only `role: 'ui'` on loopback
 *        passes (fail closed for remote/agent/plugin callers)
 * @param {(record: object) => void} [options.audit]
 * @param {{windowMs?: number, perActor?: number, perId?: number}} [options.rateLimit]
 * @param {() => number} [options.now]
 */
export function createArchiveRpc({ service, authorize, audit, rateLimit = {}, now = () => Date.now() } = {}) {
  if (!service || typeof service.delete !== 'function') {
    throw new TypeError('dsh-toolbox: createArchiveRpc needs an archive service')
  }
  const windowMs = Number.isFinite(rateLimit.windowMs) ? rateLimit.windowMs : 60_000
  const perActor = Number.isFinite(rateLimit.perActor) ? rateLimit.perActor : 30
  const perId = Number.isFinite(rateLimit.perId) ? rateLimit.perId : 10
  // P2-11: actors and ids live in SEPARATE bounded maps. One shared map let an
  // attacker flush the actor key with 1025 junk ids and reset the actor limit.
  const actorHits = new Map()
  const idHits = new Map()
  const maxTrackedActors = Number.isFinite(rateLimit.maxTrackedActors) ? rateLimit.maxTrackedActors : 256
  const maxTrackedIds = Number.isFinite(rateLimit.maxTrackedIds) ? rateLimit.maxTrackedIds : 1024

  const isWriter = audit && typeof audit === 'object' && typeof audit.allow === 'function'

  /**
   * Write one record. A plain sink gets everything (tests, simple hosts); a
   * WRITER aggregates rejections so an unauthenticated flood cannot fill the log.
   */
  function record(entry) {
    try {
      if (isWriter) {
        if (entry && entry.ok === true) audit.allow(pick(entry))
        else audit.reject(pick(entry))
        return
      }
      if (typeof audit === 'function') audit(pick(entry))
    } catch (error) {
      /* an audit sink must never break a delete */
    }
  }

  /** Default policy: only the local UI role may act. Remote/agent/plugin refuse. */
  function defaultAuthorize(principal, action) {
    if (!principal || typeof principal !== 'object') return false
    if (principal.role !== 'ui') return false
    if (action === METHODS.LIST || action === METHODS.HEAL) return true
    return principal.local === true
  }

  const allowed = typeof authorize === 'function' ? authorize : defaultAuthorize

  function bump(map, key, max, at, cap) {
    const recent = (map.get(key) || []).filter((stamp) => at - stamp < windowMs)
    if (recent.length >= max) {
      map.set(key, recent)
      return false
    }
    recent.push(at)
    map.set(key, recent)
    while (map.size > cap) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
    return true
  }

  /** The actor window always counts; the id window only when there is an id. */
  function withinLimit(actorKey, id, at) {
    const actorOk = bump(actorHits, 'actor:' + actorKey, perActor, at, maxTrackedActors)
    if (id === undefined) return actorOk
    return bump(idHits, id, perId, at, maxTrackedIds) && actorOk
  }

  /**
   * Run one method with authorization, rate limiting, whitelisting and audit.
   * Never throws.
   */
  async function call(principal, action, id, run, limitWithoutId = false) {
    const at = now()
    const actorKey = principal && principal.id ? String(principal.id).slice(0, 64) : '(anonymous)'
    const base = {
      at,
      actor: actorKey,
      role: principal && principal.role,
      source: principal && principal.source,
      action,
    }

    if (!principal || typeof principal !== 'object') {
      record({ ...base, ok: false, reason: 'unauthenticated' })
      return { ok: false, status: 401, reason: 'unauthenticated' }
    }
    if (!allowed(principal, action, id)) {
      record({ ...base, ok: false, reason: 'forbidden', ...(id ? { id } : {}) })
      return { ok: false, status: 403, reason: 'forbidden' }
    }
    if ((id !== undefined || limitWithoutId) && !withinLimit(actorKey, id, at)) {
      record({ ...base, ok: false, reason: 'rate-limited', id })
      return { ok: false, status: 429, reason: 'rate-limited' }
    }

    let result
    try {
      result = await run()
    } catch (error) {
      record({ ...base, ok: false, reason: 'internal-error', ...(id ? { id } : {}) })
      return { ok: false, status: 500, reason: 'internal-error' }
    }
    const safe = pickResponse(result)
    record({
      ...base,
      ok: safe.ok === true,
      reason: safe.reason,
      warning: safe.warning ? 'yes' : undefined,
      ...(id ? { id } : {}),
    })
    return safe
  }

  return {
    /**
     * @param {{id: string, role: string, source?: string, local?: boolean}} principal
     * @param {string} sessionId
     */
    async delete(principal, sessionId) {
      if (typeof sessionId !== 'string' || !isSafeSessionId(sessionId)) {
        record({ at: now(), actor: principal && principal.id, action: METHODS.DELETE, ok: false, reason: 'invalid-id' })
        return { ok: false, status: 400, reason: 'invalid-id' }
      }
      return call(principal, METHODS.DELETE, sessionId, () => service.delete(sessionId))
    },

    async restore(principal, sessionId) {
      if (typeof sessionId !== 'string' || !isSafeSessionId(sessionId)) {
        record({ at: now(), actor: principal && principal.id, action: METHODS.RESTORE, ok: false, reason: 'invalid-id' })
        return { ok: false, status: 400, reason: 'invalid-id' }
      }
      return call(principal, METHODS.RESTORE, sessionId, () => service.restore(sessionId))
    },

    async heal(principal) {
      // P2-11: heal/list are rate limited per actor too, or an authenticated
      // client can spin them forever and write an audit line each time.
      return call(principal, METHODS.HEAL, undefined, () => service.heal(), true)
    },

    async list(principal) {
      return call(principal, METHODS.LIST, undefined, () => service.list(), true)
    },

    /** Bounded-map diagnostics (Pi D). */
    stats() {
      return { trackedIds: idHits.size, trackedActors: actorHits.size, maxTrackedIds, maxTrackedActors }
    },
  }
}

/**
 * A faithful stand-in for the DSH gateway: one entry point, a principal per call,
 * an unknown method is a 404 rather than an exception.
 *
 * @param {object} options
 * @param {object} options.rpc - from createArchiveRpc
 */
export function createArchiveGateway({ rpc, resolvePrincipal, allowPrincipalFromRequest = false } = {}) {
  const table = {
    [METHODS.DELETE]: (principal, params) => rpc.delete(principal, params.sessionId),
    [METHODS.RESTORE]: (principal, params) => rpc.restore(principal, params.sessionId),
    [METHODS.HEAL]: (principal) => rpc.heal(principal),
    [METHODS.LIST]: (principal) => rpc.list(principal),
  }

  return {
    methods: Object.keys(table),
    /**
     * @param {{method: string, params?: object, principal?: object}} request
     */
    async dispatch(request) {
      if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
        return { ok: false, status: 400, reason: 'bad-request' }
      }
      const handler = table[request.method]
      if (!handler) return { ok: false, status: 404, reason: 'unknown-method' }
      // P2-11: the identity comes from the CONNECTION, never from the body. A
      // dispatcher that trusts `request.principal` lets anyone self-declare
      // `{role:'ui', local:true}`.
      const principal = typeof resolvePrincipal === 'function'
        ? resolvePrincipal(request)
        : allowPrincipalFromRequest
          ? request.principal
          : undefined
      return handler(principal, request.params || {})
    },
  }
}
