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
import { createSessionAdapter, adapterIsUsable } from './features/archive/session-adapter.js'
import { createArchiveApi } from './features/archive/service-deps.js'
import { readTrashKeptDays } from './config.js'
import { sweepExpiredTrash } from './features/archive/trash-sweep.js'
import { dshHome } from './features/archive/paths.js'
import { join } from 'node:path'

export { Config, isOn, readConfig, readTrashKeptDays }
export const name = 'dsh-toolbox'
/**
 * This Cordis accepts the ARRAY form only: an object `{required, optional}` is
 * read as a list of service names and the plugin sits in `pending` forever
 * ("waiting for services: required, optional"). Optional services are waited for
 * with `ctx.inject([...], cb)` below instead.
 */
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
  let archiveHttpApi = undefined
  /**
   * The real API surface (service + deps) is built ONCE, lazily, and only when the
   * profile actually exposes a workspaceRegistry. Without it the archive feature
   * stays off rather than half-working.
   */
  let archiveApi = null
  let archiveApiReason = 'not attempted'
  const ensureArchiveApi = () => {
    if (archiveApi !== null) return archiveApi
    const serviceOf = (name) => {
      try {
        return typeof sessionCtx.get === 'function' ? sessionCtx.get(name) : undefined
      } catch (error) {
        return undefined
      }
    }
    const registry = serviceOf('workspaceRegistry')
    const sessions = serviceOf('sessions')
    console.info('[dsh-toolbox] archive adapter probe: workspaceRegistry=' + (registry ? typeof registry : 'missing') + ', sessions=' + (sessions ? typeof sessions : 'missing'))
    let adapter = null
    try {
      adapter = createSessionAdapter({ registry, sessions })
    } catch (error) {
      archiveApiReason = 'createSessionAdapter threw: ' + (error && error.message)
      console.warn('[dsh-toolbox] ' + archiveApiReason)
      return null
    }
    if (!adapterIsUsable(adapter)) {
      archiveApiReason = 'adapter unusable (registry=' + (registry ? 'object' : 'missing') + ', sessions=' + (sessions ? 'object' : 'missing') + ')'
      console.warn('[dsh-toolbox] ' + archiveApiReason)
      return null
    }
    archiveApiReason = 'ready' + (adapter.readOnly ? ' (read-only)' : '')
    try {
      const built = createArchiveApi({
          home: join(dshHome(), 'storages'),
          adapter,
          // 传函数：配置改了立刻生效，不用重建服务。
          trashKeptDays: () => readTrashKeptDays(config),
        })
      archiveApi = built.api
      // 垃圾箱只在保留期到期后才物理清空，启动时扫一次。
      void sweepExpiredTrash({ journal: built.deps.journal, service: built.service, ttlDays: readTrashKeptDays(config) })
        .then((r) => {
          if (r && r.scanned > 0) console.info('[dsh-toolbox] 垃圾箱过期清理：扫描 ' + r.scanned + '，清空 ' + r.purged)
        })
        .catch((error) => console.warn('[dsh-toolbox] 垃圾箱清理失败', error))
    } catch (error) {
      archiveApiReason = 'createArchiveApi threw: ' + (error && (error.message || String(error)))
      console.error('[dsh-toolbox] building the archive service failed; the HTTP api stays off: ' + archiveApiReason, error)
      return null
    }
    return archiveApi
  }
  const archiveRegistry = createTokenRegistry()

  /**
   * Mount/tear down the experimental HTTP archive API. Optional on purpose: a
   * host without a web server still gets every other feature.
   */
  const syncArchiveHttp = (reason) => {
    console.info('[dsh-toolbox] archive sync (' + reason + ')')
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
    // The api object changes when the session services arrive late: the first
    // mount happened with api=null, so the routes answer 503. Rebuild instead of
    // reusing it.
    const wantedApi = ensureArchiveApi()
    if (archiveHttp !== null && archiveHttpApi !== wantedApi) {
      archiveHttp.dispose()
      archiveHttp = null
    }
    if (archiveHttp === null) {
      archiveHttpApi = wantedApi
      archiveHttp = createArchiveHttpLifecycle({
        readEnabled: () => isOn(config, 'archiveHttpApi'),
        registry: archiveRegistry,
        webServer,
        token: archiveRegistry.current(),
        origins: archiveOrigins(webServer),
        // The HTTP layer is complete; the session adapter is what still has to be
        // bound to a real profile service. Until then the route answers honestly
        // instead of pretending to delete.
        api: wantedApi,
        apiReason: () => archiveApiReason,
        onDelete: (id) => {
          const api = ensureArchiveApi()
          if (api === null) return { ok: false, status: 503, reason: 'archive-session-adapter-unavailable' }
          const outcome = api.delete(id)
          Promise.resolve(outcome).then((r) => {
            if (r && r.ok === false) console.warn('[dsh-toolbox] 删除被拒 ' + id + ' -> ' + r.reason + (r.status ? ' (HTTP ' + r.status + ')' : ''))
          }).catch(() => {})
          return outcome
        },
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

  // The session services may arrive after this plugin: wait for them instead of
  // reading once. `ctx.inject(deps, cb)` runs cb in a scope that carries them.
  let sessionCtx = ctx
  try {
    const offServices = ctx.inject(['workspaceRegistry', 'sessions'], (scoped) => {
      if (scoped) sessionCtx = scoped
      // The first API may have been built read-only before these services
      // arrived. Drop it so the rebuild uses the real workspaceRegistry.
      archiveApi = null
      console.info('[dsh-toolbox] session services ready; rebuilding the archive adapter')
      syncArchiveHttp('services-ready')
    })
    if (typeof offServices === 'function') ctx.effect(() => offServices, 'dsh-toolbox: session services injection')
  } catch (error) {
    console.warn('[dsh-toolbox] ctx.inject([session services]) failed: ' + (error && error.message))
  }

  // webServer may not exist yet when apply runs: `ctx.get` would answer
  // undefined exactly once and the routes would never be attempted. `inject`
  // waits for the service and runs the callback in its scope.
  try {
    const disposeInject = ctx.inject(['webServer'], () => {
      console.info('[dsh-toolbox] webServer became available; syncing the archive routes')
      syncArchiveHttp('webServer-ready')
    })
    if (typeof disposeInject === 'function') ctx.effect(() => disposeInject, 'dsh-toolbox: webServer injection')
  } catch (error) {
    console.warn('[dsh-toolbox] ctx.inject([webServer]) failed: ' + (error && error.message))
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
