/**
 * S4-c · mount the archive feature on the host (Pi's plan A).
 *
 * Two routes belong to this feature and they live or die TOGETHER:
 *
 *   GET  /api/archive-manager/token    issues the per-process credential
 *   POST /api/archive-manager/delete   the guarded delete
 *
 * A delete route without a token route is unusable (the UI could never get a
 * credential); a token route without a delete route is dead surface. So the two
 * are registered as one unit: if either registration throws, the other is rolled
 * back and nothing is left mounted.
 *
 * Nothing is mounted unless the caller explicitly enables it AND supplies a
 * token AND the origins it really serves. Missing any of the three is a refusal,
 * not a partial mount.
 */

import { TOKEN_PATH, createTokenEndpoint } from './token-route.js'
import { DELETE_PATH, createRouteGuard, registerArchiveRoutes } from './route-guard.js'
import { LIST_PATH, UNARCHIVE_PATH, createApiHandlers } from './api-routes.js'

/**
 * @param {object} options
 * @param {{register: Function}} options.webServer
 * @param {string} options.token - per-process credential (>= 32 chars)
 * @param {string[]} options.origins - the origins this host really serves
 * @param {(id: string) => object} options.onDelete
 * @param {object} options.registry - from createTokenRegistry
 * @param {boolean} [options.enabled]
 * @param {boolean} [options.trustProxy]
 * @returns {{registered: boolean, reason?: string, dispose: Function, routes: string[]}}
 */
export function mountArchiveRoutes({ webServer, token, origins, onDelete, registry, api, enabled = false, trustProxy = false } = {}) {
  const nothing = { registered: false, reason: 'not mounted', dispose() {}, routes: [] }

  if (enabled !== true) return { ...nothing, reason: 'archive http routes are disabled by configuration' }
  if (!webServer || typeof webServer.register !== 'function') return { ...nothing, reason: 'no web server' }
  if (typeof token !== 'string' || token.length < 32) return { ...nothing, reason: 'no route token configured' }
  if (!Array.isArray(origins) || origins.length === 0) return { ...nothing, reason: 'no allowed origins configured' }
  if (!registry || typeof registry.current !== 'function') return { ...nothing, reason: 'no token registry' }
  if (typeof onDelete !== 'function') return { ...nothing, reason: 'no delete handler' }

  const disposers = []
  let tokenDisposer
  let deleteDisposer

  try {
    // 1) the credential route
    tokenDisposer = webServer.register({
      kind: 'exact',
      method: 'GET',
      path: TOKEN_PATH,
      handler: createTokenEndpoint({ registry, origins, trustProxy }),
    })
    if (typeof tokenDisposer === 'function') disposers.push(tokenDisposer)

    // 2) the delete route (fail-closed on its own as well)
    const registration = registerArchiveRoutes({ webServer, onDelete, token, origins, trustProxy, enabled: true })
    if (registration.registered !== true) throw new Error('delete route refused to register: ' + registration.reason)
    deleteDisposer = registration.dispose
    if (typeof deleteDisposer === 'function') disposers.push(deleteDisposer)

    // 3) the two routes the panel also needs, under the SAME guard and token.
    if (api && typeof api.list === 'function') {
      // list is a GET, unarchive a POST: one guard that allows both.\n      const apiGuard = createRouteGuard({ allowedOrigins: origins, token, trustProxy, methods: ['GET', 'POST'] })\n      const handlers = createApiHandlers({ guard: apiGuard, peerOf: (req) => req.socket && req.socket.remoteAddress, api })
      const listDisposer = webServer.register({ kind: 'exact', method: 'GET', path: LIST_PATH, handler: handlers.list })
      if (typeof listDisposer === 'function') disposers.push(listDisposer)
      const unarchiveDisposer = webServer.register({ kind: 'exact', method: 'POST', path: UNARCHIVE_PATH, handler: handlers.unarchive })
      if (typeof unarchiveDisposer === 'function') disposers.push(unarchiveDisposer)
    }
  } catch (error) {
    // Composite rollback: a half-mounted pair is worse than nothing mounted.
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (cleanupError) {
        /* keep unwinding */
      }
    }
    return { registered: false, reason: String(error && error.message ? error.message : error), dispose() {}, routes: [] }
  }

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const one of disposers.reverse()) {
      try {
        one()
      } catch (error) {
        /* a disposer must never throw outward */
      }
    }
  }

  return { registered: true, dispose, routes: [TOKEN_PATH, DELETE_PATH, ...(api ? [LIST_PATH, UNARCHIVE_PATH] : [])] }
}


/**
 * The switch-driven lifecycle of the pair (Pi: the switch must not be a placebo).
 *
 * `sync()` runs on apply AND on every `loader/volatile-update`, so flipping the
 * switch takes effect without a restart:
 *
 *   off -> on   mounts token + delete together
 *   on  -> off  disposes both AND rotates the credential, so a page still holding
 *               the old token gets 401 instead of a working handle
 *   mount fails nothing stays registered; the reason is returned
 */
export function createArchiveHttpLifecycle({ readEnabled, registry, webServer, token, origins, onDelete, trustProxy = false } = {}) {
  let mounted = null

  function wants() {
    try {
      return readEnabled() === true
    } catch (error) {
      return false
    }
  }

  function sync() {
    const want = wants()
    if (want && mounted === null) {
      const result = mountArchiveRoutes({ webServer, token, origins, onDelete, registry, trustProxy, enabled: true })
      if (result.registered !== true) return { registered: false, reason: result.reason }
      mounted = result
      return { registered: true }
    }
    if (!want && mounted !== null) {
      mounted.dispose()
      mounted = null
      // The old credential must not outlive the switch.
      if (registry && typeof registry.rotate === 'function') registry.rotate()
      return { registered: false, reason: 'disabled' }
    }
    return { registered: mounted !== null }
  }

  return {
    sync,
    status: () => ({ registered: mounted !== null }),
    dispose() {
      if (mounted === null) return
      mounted.dispose()
      mounted = null
    },
  }
}