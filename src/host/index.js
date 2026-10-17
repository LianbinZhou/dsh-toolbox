/**
 * Host half of dsh-toolbox.
 *
 * Two rules learned the hard way in the S1 review:
 *
 * 1. **`apply` must not return a plain object.** Cordis collects the return value
 *    as an effect and rejects anything that is not a function, null/undefined, a
 *    thenable or an iterable with `Invalid effect` (reproduced on the real
 *    runtime). So `apply` returns nothing here.
 * 2. **A settings read that fails must not switch a feature on.** Every read goes
 *    through `isOn`, which is fail-closed, and the guard denies its own tool when
 *    it cannot prove the switch is on.
 *
 * S2: the probe is gone. `session_search` is the real feature now, gated by the
 * `sessionSearch` switch and reconciled on `loader/volatile-update`.
 */

import { Config, isOn, readConfig } from './config.js'
import { install as installSessionSearch } from './features/session-search.js'
import { createArchiveHttpLifecycle } from './features/archive/host-feature.js'
import { createTokenRegistry } from './features/archive/token-route.js'

export { Config, isOn, readConfig }
export const name = 'dsh-toolbox'
export const inject = ['tools']

export const GUARDED_TOOL = 'session_search'

/** The denial text: say who did it, say do not retry, offer a way forward. */
export const DENIAL =
  GUARDED_TOOL +
  ' is switched off by the user in dsh-toolbox settings. Do not retry it; ' +
  'answer from the current conversation, or ask the user to turn the switch back on.'

/**
 * The guard for a switch that only hides the tool.
 *
 * - It never throws: `tools.guard` runs inside the tool pipeline, so a throw here
 *   would become a tool error for EVERY tool.
 * - It checks the tool name before touching the config, so unrelated tools are
 *   never denied.
 * - It fails closed for its own tool: if the switch cannot be read, it denies.
 *
 * @param config - the row config (volatile ref or plain object)
 * @returns the guard predicate
 */
export function makeGuard(config) {
  return function toolboxGuard(exec) {
    let target
    try {
      target = exec && exec.name
    } catch (error) {
      return undefined
    }
    if (target !== GUARDED_TOOL) return undefined
    try {
      return isOn(config, 'sessionSearch') ? undefined : DENIAL
    } catch (error) {
      console.error('[dsh-toolbox] guard read failed; denying its own tool', error)
      return DENIAL
    }
  }
}

/**
 * Activate the host half.
 * @param ctx - a Cordis context carrying the `tools` service
 * @param config - the row config
 * @returns nothing — a plain object here is an `Invalid effect` crash
 */
/**
 * The origins the delete route will accept, derived from the address the host
 * really bound. Never from a request header (that is the R0 bug).
 */
export function archiveOrigins(webServer) {
  let port
  try {
    if (webServer && typeof webServer.port === 'number') port = webServer.port
    else if (webServer && typeof webServer.address === 'function') port = webServer.address()?.port
  } catch (error) {
    port = undefined
  }
  const known = Number.isFinite(port) ? port : 3080
  return ['http://127.0.0.1:' + known, 'http://localhost:' + known]
}

export function apply(ctx, config) {
  let offTool
  let archiveHttp = null
  // Set by the host once a session adapter exists (see createArchiveApi).
  const archiveApi = typeof config?.__archiveApi === 'object' ? config.__archiveApi : null
  const archiveRegistry = createTokenRegistry()

  /**
   * Mount/tear down the experimental HTTP archive API. Optional on purpose: a
   * host without a web server still gets every other feature.
   */
  const syncArchiveHttp = (reason) => {
    let webServer
    try {
      webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    } catch (error) {
      webServer = undefined
    }
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      if (archiveHttp !== null) {
        archiveHttp.dispose()
        archiveHttp = null
      }
      return
    }
    if (archiveHttp === null) {
      archiveHttp = createArchiveHttpLifecycle({
        readEnabled: () => isOn(config, 'archiveHttpApi'),
        registry: archiveRegistry,
        webServer,
        token: archiveRegistry.current(),
        origins: archiveOrigins(webServer),
        // The HTTP layer is complete; the session adapter is what still has to be
        // bound to a real profile service. Until then the route answers honestly
        // instead of pretending to delete.
        api: archiveApi || {
          list: () => ({ ok: false, rows: [] }),
          unarchive: () => ({ ok: false }),
          delete: () => ({ ok: false, status: 503, reason: 'archive-session-adapter-unavailable' }),
        },
        onDelete: (id) => archiveApi.delete(id),
      })
    }
    const state = archiveHttp.sync()
    console.info('[dsh-toolbox] archive http api ' + (state.registered ? 'mounted' : 'off') + ' (' + reason + ')' + (state.reason ? ': ' + state.reason : ''))
  }

  const sync = (reason) => {
    const want = isOn(config, 'sessionSearch')
    if (want && offTool === undefined) {
      offTool = installSessionSearch(ctx)
      console.info('[dsh-toolbox] session_search installed (' + reason + ')')
    } else if (!want && offTool !== undefined) {
      try {
        offTool()
      } catch (error) {
        console.error('[dsh-toolbox] disposing session_search failed', error)
      }
      offTool = undefined
      console.info('[dsh-toolbox] session_search disposed (' + reason + ')')
    }
  }

  ctx.effect(() => {
    const offEvent = ctx.on('loader/volatile-update', () => {
      sync('volatile-update')
      syncArchiveHttp('volatile-update')
    })
    sync('apply')
    syncArchiveHttp('apply')
    return () => {
      try {
        offEvent()
      } catch (error) {
        console.error('[dsh-toolbox] removing the volatile listener failed', error)
      }
      if (offTool !== undefined) {
        try {
          offTool()
        } catch (error) {
          console.error('[dsh-toolbox] disposing session_search on teardown failed', error)
        }
        offTool = undefined
      }
      if (archiveHttp !== null) {
        try {
          archiveHttp.dispose()
        } catch (error) {
          console.error('[dsh-toolbox] disposing the archive http api failed', error)
        }
        archiveHttp = null
      }
    }
  }, 'dsh-toolbox: volatile switch drives session_search')

  if (ctx.tools && typeof ctx.tools.guard === 'function') {
    ctx.effect(() => ctx.tools.guard(makeGuard(config)), 'dsh-toolbox: guarded tool switch')
  }

  // Deliberately no return value: see the header.
}

/** Read-only helper for diagnostics and tests (not returned from `apply`). */
export function currentSwitches(config) {
  const values = readConfig(config)
  const out = {}
  for (const key of Object.keys(values)) out[key] = values[key]
  return out
}
