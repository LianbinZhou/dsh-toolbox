/**
 * Browser entry. This is the file esbuild turns into `client.js`.
 *
 * It exists to solve P0-2: the module must register itself through the loader,
 * and it must receive React from the loader instead of importing it.
 *
 * The factory parameter is deliberately named `load`, not `require`: esbuild
 * rewrites a syntactic `require("react")` into its own `__require` shim, which
 * throws in the browser. A call through a differently named parameter stays a
 * plain call.
 */

import { installRuntime } from './runtime.js'
import { createContainer } from './container.js'
import { createFeatures, createFeatureProbe } from './features.js'
import { readSwitches, cacheSwitches, watchSwitches } from './switches.js'

function apply(ctx) {
  const probe = createFeatureProbe()
  const listeners = new Set()

  const host = {
    addListener(id, listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    listenerCount: () => listeners.size,
  }

  const container = createContainer({
    features: createFeatures(probe, host),
    ctx,
    env: { h: undefined, probe, host },
    readSwitches: (context) => readSwitches(context),
    cachedSwitches: () => cacheSwitches(),
    watchSwitches: (context, callback) => watchSwitches(context, callback),
    onError: (id, error) => console.error('[dsh-toolbox] ' + id, error),
  })

  // Diagnostics surface, used by the artifact test and by on-page debugging.
  window.__DSH_TOOLBOX__ = {
    phaseOf: container.phaseOf,
    liveCount: container.liveCount,
    mounts: probe.count,
    listeners: host.listenerCount,
  }

  // Returning the disposer keeps the plugin testable; it is registered with the
  // fiber either way, so this changes nothing for the Host.
  return ctx.effect(() => () => {
    container.dispose()
    listeners.clear()
    if (window.__DSH_TOOLBOX__) delete window.__DSH_TOOLBOX__
  }, 'toolbox: dispose container')
}

window.__ModuleLoader__.load({
  id: 'dsh-toolbox',
  factory(load) {
    installRuntime(load('react'))
    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
