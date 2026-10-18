/**
 * Browser entry. This is the file esbuild turns into `client.js`.
 *
 * P0-2 rules:
 *   - the module registers itself through `window.__ModuleLoader__.load({ id, factory })`;
 *   - React comes from the loader's own require and is handed to `installRuntime`;
 *     no file imports react, and the factory parameter is named `load` so esbuild
 *     cannot rewrite it into its `__require` shim;
 *   - the settings card registers `plugins.row.config` under `dsh-toolbox#toolbox`.
 */

import { installRuntime, h } from './runtime.js'
import { createContainer } from './container.js'
import { createFeatures, createFeatureProbe } from './features.js'
import { readSwitches, cacheSwitches, watchSwitches } from './switches.js'
import { createSettingsCard, SLOT, SLOT_KEY } from './form.js'

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
    // `h` is the late-bound runtime accessor, so features migrated in S2 can use it.
    env: { h, probe, host },
    readSwitches: (context, options) => readSwitches(context, options),
    cachedSwitches: () => cacheSwitches(),
    watchSwitches: (context, callback, options) => watchSwitches(context, callback, options),
    onError: (id, error) => console.error('[dsh-toolbox] ' + id, error),
  })

  // The settings card: always present, never behind a switch.
  const card = createSettingsCard(ctx)
  const offCard = ctx.effect(
    () =>
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register({ name: SLOT, key: SLOT_KEY }, (props) =>
          h(card, Object.assign({}, props, { ctx })),
        ),
      ),
    'toolbox: settings card on the plugin row',
  )

  window.__DSH_TOOLBOX__ = {
    phaseOf: container.phaseOf,
    liveCount: container.liveCount,
    mounts: probe.count,
    listeners: host.listenerCount,
    slot: SLOT + '#' + SLOT_KEY,
  }

  return ctx.effect(() => () => {
    try {
      if (typeof offCard === 'function') offCard()
      else if (offCard && typeof offCard.dispose === 'function') offCard.dispose()
    } catch (error) {
      console.error('[dsh-toolbox] removing the settings card failed', error)
    }
    Promise.resolve(container.dispose()).catch((error) => {
      console.error('[dsh-toolbox] container disposal failed', error)
    })
    listeners.clear()
    if (window.__DSH_TOOLBOX__) delete window.__DSH_TOOLBOX__
  }, 'toolbox: dispose container')
}

window.__ModuleLoader__.load({
  id: 'dsh-toolbox',
  factory(load) {
    installRuntime(load('react'))
    return {
      inject: ['slots', 'locale', 'sessions'],
      apply,
    }
  },
})
