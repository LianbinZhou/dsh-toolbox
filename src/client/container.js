/**
 * The container: the only place that decides what is mounted.
 *
 * Three invariants (P0-3). Each one has a test that fails without it:
 *
 *   I1. **Irreversible features wait for the real switch value.** A feature with
 *       `reversible: false` is never mounted from the cache and never mounted
 *       while `settingsReady` is false. The cache can only preload reversible
 *       features, and a feature whose key is absent from the values is OFF.
 *   I2. **A mount that finishes after the switch flipped is rolled back.** The
 *       state machine writes `mounting` before calling `mount`, and after `mount`
 *       returns it re-checks `want`, `disposed` and a per-feature generation
 *       counter. Any mismatch disposes the scope and leaves the feature `off`.
 *   I3. **No effect is unowned.** Whatever `mount` returns is tracked, in
 *       addition to anything the feature tracked through `env.track`.
 *
 * Reconciles are serialised on one queue, so a re-entrant call (a feature that
 * fires a settings event while mounting) cannot interleave two mounts.
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

  let disposed = false
  let settingsReady = false
  let queue = Promise.resolve()
  let values = {}

  // The initial read is asynchronous, so tests (and the on-page diagnostics)
  // need one promise that means "the first real reconcile has run".
  let markReady
  let readyDone = false
  const ready = new Promise((resolve) => {
    markReady = () => {
      if (readyDone) return
      readyDone = true
      resolve()
    }
  })

  const wantOf = (feature, source) => source[feature.configKey] === true

  /** Only keys owned by reversible features may come from the cache. */
  function reversibleOnly(cache) {
    if (!cache || typeof cache !== 'object') return {}
    const out = {}
    for (const feature of features) {
      if (feature.reversible && cache[feature.configKey] === true) out[feature.configKey] = true
    }
    return out
  }

  function mountFeature(feature) {
    const mine = (generation.get(feature.id) ?? 0) + 1
    generation.set(feature.id, mine)
    state.set(feature.id, MOUNTING)

    const scope = createScope(feature.id)
    const scopedEnv = Object.assign({}, env, { track: (value) => scope.track(value) })

    try {
      // Contract: mount may return a disposer; both forms are tracked (I3).
      scope.track(feature.mount(ctx, scopedEnv))
    } catch (error) {
      onError(feature.id, error)
      try {
        scope.dispose()
      } catch (disposeError) {
        onError(feature.id, disposeError)
      }
      state.set(feature.id, OFF)
      return
    }

    // I2: the switch may have flipped while mount was running.
    const superseded = disposed || generation.get(feature.id) !== mine || !wantOf(feature, values)
    if (superseded) {
      try {
        scope.dispose()
      } catch (error) {
        onError(feature.id, error)
      }
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
    if (!scope) return
    try {
      scope.dispose()
    } catch (error) {
      onError(feature.id, error)
    }
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

  function schedule(next) {
    queue = queue
      .then(() => {
        if (!disposed) reconcile(next)
      })
      .catch((error) => onError('container', error))
    return queue
  }

  /** Start: cache first (reversible only), then the truth, then follow changes. */
  function start() {
    if (typeof cachedSwitches === 'function') {
      schedule(reversibleOnly(safeCall(cachedSwitches, onError)))
    }

    let settled
    try {
      settled = Promise.resolve(readSwitches(ctx))
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
        // I1: a failed read is not a reason to guess. Everything off.
        onError('settings', error)
        settingsReady = true
        schedule({}).then(() => markReady())
      })

    const off = typeof watchSwitches === 'function' ? watchSwitches(ctx, (next) => schedule(next)) : undefined
    return off
  }

  function dispose() {
    if (disposed) return
    disposed = true
    markReady()
    for (const [, scope] of scopes) {
      try {
        scope.dispose()
      } catch (error) {
        onError('dispose', error)
      }
    }
    scopes.clear()
    state.clear()
  }

  const stopWatching = start()

  return {
    /** Take the switch values once more (used by tests). */
    feed: (next) => schedule(next),
    /** Whether a feature is currently mounted. */
    phaseOf: (id) => state.get(id) ?? OFF,
    /** Live scopes, for leak assertions. */
    liveCount: () => scopes.size,
    dispose() {
      try {
        if (typeof stopWatching === 'function') stopWatching()
        else if (stopWatching && typeof stopWatching.dispose === 'function') stopWatching.dispose()
      } catch (error) {
        onError('watch', error)
      }
      dispose()
    },
    /** Wait for the queue (tests). */
    settled: () => queue,
    /** Wait for the first reconcile driven by the real switch values. */
    ready: () => ready,
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
