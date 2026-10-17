/**
 * The container: the only place that decides what is mounted.
 *
 * Invariants, each with a test that fails without it:
 *
 *   I1. **Irreversible features wait for the real switch value.** `reversible:false`
 *       is never mounted from the cache and never while `settingsReady` is false.
 *       A feature whose key is absent from the values is OFF. A failed read is a
 *       reason to mount nothing, not a reason to guess.
 *   I2. **A mount that finishes after the switch flipped is rolled back.** The
 *       state machine writes `mounting` before calling `mount`, then re-checks
 *       `want`, `disposed` and a per-feature generation counter. `feedSync()`
 *       exists so a test can really re-enter during `mount`; `feed()` only queues.
 *   I3. **No effect is unowned.** Whatever `mount` returns is tracked in addition
 *       to anything the feature tracked through `env.track`.
 *
 * Teardown is asynchronous: Cordis fibers dispose through promises, so settled
 * states await them instead of leaving rejections behind.
 */

import { createScope } from './scope.js'

const OFF = 'off'
const MOUNTING = 'mounting'
const MOUNTED = 'mounted'

export function createContainer(options) {
  const {
    features,
    ctx,
    env = {},
    readSwitches,
    cachedSwitches,
    watchSwitches,
    onError = (id, error) => console.error('[dsh-toolbox] ' + id, error),
  } = options

  const state = new Map()
  const scopes = new Map()
  const generation = new Map()
  const pendingDisposals = []

  let disposed = false
  let settingsReady = false
  let queue = Promise.resolve()
  let values = {}

  let markReady
  let readyDone = false
  const ready = new Promise((resolve) => {
    markReady = () => {
      if (readyDone) return
      readyDone = true
      resolve()
    }
  })

  const isCancelled = () => disposed
  const wantOf = (feature, source) => source[feature.configKey] === true

  function reversibleOnly(cache) {
    if (!cache || typeof cache !== 'object') return {}
    const out = {}
    for (const feature of features) {
      if (feature.reversible && cache[feature.configKey] === true) out[feature.configKey] = true
    }
    return out
  }

  function disposeScope(scope) {
    try {
      const result = scope.dispose()
      if (result && typeof result.then === 'function') {
        pendingDisposals.push(
          Promise.resolve(result).catch((error) => {
            onError(scope.label, error)
          }),
        )
      }
    } catch (error) {
      onError(scope.label, error)
    }
  }

  function mountFeature(feature) {
    const mine = (generation.get(feature.id) ?? 0) + 1
    generation.set(feature.id, mine)
    state.set(feature.id, MOUNTING)

    const scope = createScope(feature.id)
    const scopedEnv = Object.assign({}, env, { track: (value) => scope.track(value) })

    try {
      scope.track(feature.mount(ctx, scopedEnv))
    } catch (error) {
      onError(feature.id, error)
      disposeScope(scope)
      state.set(feature.id, OFF)
      return
    }

    // I2: the switch may have flipped while mount was running.
    const superseded = disposed || generation.get(feature.id) !== mine || !wantOf(feature, values)
    if (superseded) {
      disposeScope(scope)
      state.set(feature.id, OFF)
      return
    }

    scopes.set(feature.id, scope)
    state.set(feature.id, MOUNTED)
  }

  function unmountFeature(feature) {
    generation.set(feature.id, (generation.get(feature.id) ?? 0) + 1)
    const scope = scopes.get(feature.id)
    scopes.delete(feature.id)
    state.set(feature.id, OFF)
    if (scope) disposeScope(scope)
  }

  function reconcile(next) {
    if (disposed) return
    values = next && typeof next === 'object' ? next : {}

    for (const feature of features) {
      const want = wantOf(feature, values)
      const phase = state.get(feature.id) ?? OFF

      // I1: an irreversible feature waits for the truth, and never mounts on a missing value.
      if (!feature.reversible) {
        if (!settingsReady) continue
        if (values[feature.configKey] === undefined) continue
      }

      if (want && phase === OFF) mountFeature(feature)
      else if (!want && (phase === MOUNTED || phase === MOUNTING)) unmountFeature(feature)
    }
  }

  function flushDisposals() {
    return Promise.all(pendingDisposals.splice(0)).then(() => undefined)
  }

  function schedule(next) {
    queue = queue
      .then(() => {
        if (!disposed) reconcile(next)
        return flushDisposals()
      })
      .catch((error) => onError('container', error))
    return queue
  }

  function start() {
    if (typeof cachedSwitches === 'function') {
      schedule(reversibleOnly(safeCall(cachedSwitches, onError)))
    }

    let settled
    try {
      settled = Promise.resolve(readSwitches(ctx, { isCancelled }))
    } catch (error) {
      settled = Promise.reject(error)
    }
    settled
      .then((next) => {
        settingsReady = true
        return schedule(next)
      })
      .then(() => markReady())
      .catch((error) => {
        onError('settings', error)
        settingsReady = true
        schedule({}).then(() => markReady())
      })

    const off =
      typeof watchSwitches === 'function'
        ? watchSwitches(ctx, (next) => schedule(next), { isCancelled })
        : undefined
    return off
  }

  function dispose() {
    if (disposed) return Promise.resolve()
    disposed = true
    markReady()
    for (const [, scope] of scopes) disposeScope(scope)
    scopes.clear()
    state.clear()
    return flushDisposals()
  }

  const stopWatching = start()

  return {
    /** Queue new switch values (production path). */
    feed: (next) => schedule(next),
    /** Reconcile immediately, inside the current call. Used to test real re-entry. */
    feedSync: (next) => reconcile(next),
    phaseOf: (id) => state.get(id) ?? OFF,
    liveCount: () => scopes.size,
    /** Resolves after the queue and every async disposal has settled. */
    settled: () => queue.then(() => flushDisposals()),
    /** Resolves after the first reconcile driven by the real switch values. */
    ready: () => ready,
    dispose() {
      try {
        if (typeof stopWatching === 'function') stopWatching()
        else if (stopWatching && typeof stopWatching.dispose === 'function') stopWatching.dispose()
      } catch (error) {
        onError('watch', error)
      }
      return dispose()
    },
  }
}

function safeCall(fn, onError) {
  try {
    return fn()
  } catch (error) {
    onError('cache', error)
    return undefined
  }
}
