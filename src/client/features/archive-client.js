/**
 * S4-c · the client half of the guarded delete (Pi's plan A).
 *
 * Three rules, and nothing else belongs in this file:
 *
 *  1. The token lives in a CLOSURE. Not localStorage, not sessionStorage, not a
 *     DOM attribute, not `window`, not a URL. A page refresh asks again.
 *  2. A 401 refreshes ONCE and retries ONCE. If that also fails the caller gets a
 *     stable `refresh-required` code and the UI tells the user to reload; there
 *     is no retry loop.
 *  3. Concurrent requests share ONE in-flight refresh (single flight). Without
 *     it, ten parallel deletes after a server restart would fire ten token
 *     requests at once.
 */

export const TOKEN_PATH = '/api/archive-manager/token'
export const DELETE_PATH = '/api/archive-manager/delete'
export const LIST_PATH = '/api/archive-manager/list'
export const UNARCHIVE_PATH = '/api/archive-manager/unarchive'
export const CSRF_HEADER = 'x-dsh-toolbox'
export const TOKEN_HEADER = 'x-dsh-toolbox-token'

const MIN_TOKEN_LENGTH = 32

/**
 * @param {object} options
 * @param {Function} options.fetchImpl - injected so tests need no network
 * @param {() => string} [options.base] - origin prefix ('' = same origin)
 */
export function createArchiveClient({ fetchImpl, base = () => '' } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('dsh-toolbox: createArchiveClient needs a fetch')

  /** The only place the token ever lives. */
  let token = null
  /** The shared in-flight refresh, so N callers produce 1 request. */
  let inFlight = null
  let disposed = false
  let refreshes = 0

  function requireAlive() {
    if (disposed) {
      const error = new Error('archive client disposed')
      error.code = 'disposed'
      throw error
    }
  }

  /** Get (or refresh) the token. Concurrent callers share one request. */
  function refresh(force = false) {
    requireAlive()
    if (!force && typeof token === 'string') return Promise.resolve(token)
    if (inFlight !== null) return inFlight
    inFlight = (async () => {
      try {
        const response = await fetchImpl(base() + TOKEN_PATH, {
          method: 'GET',
          headers: { [CSRF_HEADER]: '1' },
          credentials: 'same-origin',
          cache: 'no-store',
        })
        if (!response || response.ok !== true) throw new Error('token-unavailable')
        const body = await response.json()
        if (!body || typeof body.token !== 'string' || body.token.length < MIN_TOKEN_LENGTH) {
          throw new Error('token-unavailable')
        }
        token = body.token
        refreshes += 1
        return token
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  /** POST one delete with the current token. */
  function post(sessionId, credential) {
    return fetchImpl(base() + DELETE_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CSRF_HEADER]: '1',
        [TOKEN_HEADER]: credential,
      },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ sessionId }),
    })
  }

  /**
   * One authorized request. A 401 refreshes ONCE (shared) and retries ONCE.
   * @returns {{status:number, response:object, reason?:string}}
   */
  async function authorized(path, init) {
    let credential
    try {
      credential = token !== null ? token : await refresh()
    } catch (error) {
      return { status: 0, reason: 'token-unavailable' }
    }
    const send = (value) => fetchImpl(base() + path, {
      ...init,
      headers: { ...(init.headers ?? {}), [CSRF_HEADER]: '1', [TOKEN_HEADER]: value },
      credentials: 'same-origin',
      cache: 'no-store',
    })
    let response
    try {
      response = await send(credential)
    } catch (error) {
      return { status: 0, reason: 'network-error' }
    }
    if (response.status === 401) {
      token = null
      let fresh
      try {
        fresh = await refresh(true)
      } catch (error) {
        return { status: 401, reason: 'refresh-required' }
      }
      try {
        response = await send(fresh)
      } catch (error) {
        return { status: 0, reason: 'network-error' }
      }
      if (response.status === 401) {
        token = null
        return { status: 401, reason: 'refresh-required' }
      }
    }
    return { status: response.status, response }
  }

  async function readJson(response) {
    try {
      return await response.json()
    } catch (error) {
      return undefined
    }
  }

  return {
    /** Delete one archived session. Never throws; every failure is a code. */
    async delete(sessionId) {
      if (disposed) return { ok: false, status: 0, reason: 'disposed' }
      let credential
      try {
        credential = token !== null ? token : await refresh()
      } catch (error) {
        return { ok: false, status: 0, reason: 'token-unavailable' }
      }

      let response
      try {
        response = await post(sessionId, credential)
      } catch (error) {
        return { ok: false, status: 0, reason: 'network-error' }
      }

      if (response.status === 401) {
        // The server rotated its token (restart/rotation): forget ours, refresh
        // ONCE (shared), retry ONCE, then give the caller a stable answer.
        token = null
        let fresh
        try {
          fresh = await refresh(true)
        } catch (error) {
          return { ok: false, status: 401, reason: 'refresh-required' }
        }
        try {
          response = await post(sessionId, fresh)
        } catch (error) {
          return { ok: false, status: 0, reason: 'network-error' }
        }
        if (response.status === 401) {
          token = null
          return { ok: false, status: 401, reason: 'refresh-required' }
        }
      }

      const body = await readJson(response)
      return {
        ok: response.status === 200 && body?.ok !== false,
        status: response.status,
        reason: body?.reason ?? (response.ok ? undefined : 'request-failed'),
      }
    },


    /** GET the archived rows. */
    async list() {
      if (disposed) return { ok: false, rows: [], reason: 'disposed' }
      const result = await authorized(LIST_PATH, { method: 'GET' })
      if (result.response === undefined) return { ok: false, rows: [], reason: result.reason }
      if (result.status === 404) return { ok: false, rows: [], reason: 'http-404' }
      if (result.status === 503) return { ok: false, rows: [], reason: 'http-503' }
      const body = await readJson(result.response)
      if (!result.response.ok || body?.ok === false) {
        return { ok: false, rows: [], reason: body?.reason ?? 'request-failed' }
      }
      return { ok: true, rows: Array.isArray(body?.rows) ? body.rows : [] }
    },

    /** Undo the archive flag. */
    async unarchive(sessionId) {
      if (disposed) return { ok: false, status: 0, reason: 'disposed' }
      const result = await authorized(UNARCHIVE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      if (result.response === undefined) return { ok: false, status: 0, reason: result.reason }
      if (result.status === 404) return { ok: false, status: 404, reason: 'http-404' }
      if (result.status === 503) return { ok: false, status: 503, reason: 'http-503' }
      const body = await readJson(result.response)
      if (!result.response.ok) return { ok: false, status: result.status, reason: body?.reason ?? 'request-failed' }
      return { ok: true, status: result.status }
    },

    /** Ask for a token without deleting anything (used on panel open). */
    refresh,

    /** Diagnostics only: the token never leaves this module otherwise. */
    stats: () => ({ hasToken: typeof token === 'string', refreshes, inFlight: inFlight !== null }),

    /** Drop the memory token and any in-flight refresh. */
    dispose() {
      disposed = true
      token = null
      inFlight = null
    },
  }
}
