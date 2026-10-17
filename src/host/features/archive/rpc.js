/**
 * S4-b · the RPC channel: the PREFERRED way for the UI to delete (Pi's token
 * design, approved).
 *
 * Why this exists: the client plugin already sits behind DSH's own authenticated
 * client→host channel. Exposing an HTTP endpoint would add an attack surface that
 * we would then have to defend with an origin allowlist, a per-process token and
 * proxy checks — all of which become unnecessary when the call never touches the
 * network.
 *
 * What this module adds on top of the service:
 *
 *   - **Input gate**: the id is validated before it reaches the state machine.
 *   - **Rate limit**: a sliding window per id, so a stuck UI cannot hammer the
 *     filesystem (Pi R6).
 *   - **Audit**: `{ at, id, ok, reason }` and nothing else. No paths, no token,
 *     no draft content, no exception text (Pi R6 / P1-5).
 *
 * Deliberately free of `node:http` and `fetch`: if this file ever grows a network
 * import, the "zero attack surface" claim is no longer true. A test enforces it.
 */

import { isSafeSessionId } from './paths.js'

/** Fields an audit record may contain. Anything else is a leak. */
export const AUDIT_FIELDS = ['at', 'id', 'ok', 'reason', 'warning']

/**
 * @param {object} options
 * @param {object} options.service - createArchiveService(...) result
 * @param {(record: object) => void} [options.audit] - sink; must not throw
 * @param {{windowMs?: number, max?: number}} [options.rateLimit]
 * @param {() => number} [options.now]
 */
export function createArchiveRpc({
  service,
  audit,
  rateLimit = {},
  now = () => Date.now(),
} = {}) {
  if (!service || typeof service.delete !== 'function') {
    throw new TypeError('dsh-toolbox: createArchiveRpc needs an archive service')
  }
  const windowMs = Number.isFinite(rateLimit.windowMs) ? rateLimit.windowMs : 60_000
  const max = Number.isFinite(rateLimit.max) ? rateLimit.max : 30
  /** id -> timestamps inside the current window */
  const hits = new Map()

  function record(entry) {
    if (typeof audit !== 'function') return
    try {
      // Whitelist, never spread: a service result may carry anything.
      const safe = {}
      for (const field of AUDIT_FIELDS) {
        if (entry[field] !== undefined) safe[field] = entry[field]
      }
      audit(safe)
    } catch (error) {
      /* an audit sink must never break a delete */
    }
  }

  function withinLimit(id) {
    const at = now()
    const recent = (hits.get(id) || []).filter((stamp) => at - stamp < windowMs)
    if (recent.length >= max) {
      hits.set(id, recent)
      return false
    }
    recent.push(at)
    hits.set(id, recent)
    return true
  }

  return {
    /**
     * Delete one archived session. Never throws: every failure becomes a code.
     * @param {string} sessionId
     */
    async delete(sessionId) {
      const at = now()
      if (!isSafeSessionId(sessionId)) {
        record({ at, id: typeof sessionId === 'string' ? sessionId.slice(0, 64) : '(non-string)', ok: false, reason: 'invalid-id' })
        return { ok: false, status: 400, reason: 'invalid-id' }
      }
      if (!withinLimit(sessionId)) {
        record({ at, id: sessionId, ok: false, reason: 'rate-limited' })
        return { ok: false, status: 429, reason: 'rate-limited' }
      }
      let result
      try {
        result = await service.delete(sessionId)
      } catch (error) {
        record({ at, id: sessionId, ok: false, reason: 'internal-error' })
        return { ok: false, status: 500, reason: 'internal-error' }
      }
      record({
        at,
        id: sessionId,
        ok: result.ok === true,
        reason: result.reason,
        warning: result.warning ? 'yes' : undefined,
      })
      return result
    },

    /** Put a trashed session back. */
    async restore(sessionId) {
      const at = now()
      if (!isSafeSessionId(sessionId)) {
        record({ at, id: '(invalid)', ok: false, reason: 'invalid-id' })
        return { ok: false, status: 400, reason: 'invalid-id' }
      }
      const result = await service.restore(sessionId)
      record({ at, id: sessionId, ok: result.ok === true, reason: result.reason })
      return result
    },

    /** Finish any pending cleanup; safe to call on mount and on panel open. */
    async heal() {
      return service.heal()
    },

    /** What the panel shows. */
    async list() {
      return service.list()
    },
  }
}
