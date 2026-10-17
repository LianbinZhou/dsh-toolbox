/**
 * Container semantics. These are the red-light cases from the v2 review (P0-3).
 *
 * `container.ready()` resolves after the first reconcile driven by the REAL
 * switch values (the read is async by design). `container.feedSync()` re-enters
 * reconcile inside the current call, which is how the "switch flipped during
 * mount" case is tested for real instead of relying on microtask ordering.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createContainer } from '../src/client/container.js'
import { defineFeature, defineFeatures } from '../src/client/registry.js'

const ALL = {
  quoteReply: true,
  draftSaver: true,
  panelMenu: true,
  archivePanel: true,
  pluginZh: true,
  sessionSearch: true,
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

function probeFeature(id, configKey, reversible, log) {
  return defineFeature({
    id,
    configKey,
    reversible,
    mount(ctx, env) {
      log.mounts[id] = (log.mounts[id] ?? 0) + 1
      env.track(() => {
        log.disposals[id] = (log.disposals[id] ?? 0) + 1
      })
    },
  })
}

test('I1: an irreversible feature never mounts from the cache', async () => {
  const log = { mounts: {}, disposals: {} }
  const features = defineFeatures([
    probeFeature('reversible-one', 'quoteReply', true, log),
    probeFeature('irreversible-one', 'pluginZh', false, log),
  ])

  let resolveTruth
  const truth = new Promise((resolve) => {
    resolveTruth = resolve
  })

  const container = createContainer({
    features,
    ctx: {},
    env: {},
    readSwitches: () => truth,
    cachedSwitches: () => ({ quoteReply: true, pluginZh: true }),
    watchSwitches: () => () => {},
    onError: () => {},
  })

  await flush()
  assert.equal(log.mounts['reversible-one'], 1, 'a reversible feature may start from the cache')
  assert.equal(log.mounts['irreversible-one'], undefined, 'an irreversible feature must wait for the truth')

  resolveTruth(ALL)
  await container.ready()
  assert.equal(log.mounts['irreversible-one'], 1, 'it mounts once the real value arrives')
  container.dispose()
})

test('I1: a failed read mounts nothing irreversible and falls back to OFF', async () => {
  const log = { mounts: {}, disposals: {} }
  const features = defineFeatures([
    probeFeature('reversible-one', 'quoteReply', true, log),
    probeFeature('irreversible-one', 'pluginZh', false, log),
  ])

  const container = createContainer({
    features,
    ctx: {},
    env: {},
    readSwitches: () => Promise.reject(new Error('settings unavailable')),
    cachedSwitches: () => ({ quoteReply: true, pluginZh: true }),
    watchSwitches: () => () => {},
    onError: () => {},
  })

  await container.ready()
  assert.equal(log.mounts['irreversible-one'], undefined, 'no guessing when the read fails')
  container.dispose()
})

test('I1: an absent key is OFF, not ON', async () => {
  const log = { mounts: {}, disposals: {} }
  const features = defineFeatures([probeFeature('one', 'quoteReply', true, log)])
  const container = createContainer({
    features,
    ctx: {},
    env: {},
    readSwitches: () => Promise.resolve({}),
    cachedSwitches: () => ({}),
    watchSwitches: () => () => {},
    onError: () => {},
  })
  await container.ready()
  assert.equal(log.mounts.one, undefined)
  assert.equal(container.phaseOf('one'), 'off')
  container.dispose()
})

test('I2: a true re-entry during mount (switch flips off) rolls the mount back', async () => {
  const log = { mounts: {}, disposals: {} }
  let container
  const features = defineFeatures([
    {
      id: 'slow',
      configKey: 'quoteReply',
      reversible: true,
      mount(ctx, env) {
        log.mounts.slow = (log.mounts.slow ?? 0) + 1
        env.track(() => {
          log.disposals.slow = (log.disposals.slow ?? 0) + 1
        })
        // Re-enter reconcile NOW, while phase === 'mounting'.
        container.feedSync({ quoteReply: false })
      },
    },
  ])

  container = createContainer({
    features,
    ctx: {},
    env: {},
    readSwitches: () => Promise.resolve({ quoteReply: true }),
    cachedSwitches: () => ({}),
    watchSwitches: () => () => {},
    onError: () => {},
  })

  await container.ready()
  await flush()
  assert.equal(log.mounts.slow, 1, 'mount ran once')
  assert.equal(log.disposals.slow, 1, 'the effect registered during mount was undone')
  assert.equal(container.phaseOf('slow'), 'off', 'the feature did not stay mounted')
  assert.equal(container.liveCount(), 0)
  container.dispose()
})

test('I2: a re-entrant reconcile cannot double-mount', async () => {
  const log = { mounts: {}, disposals: {} }
  let container
  const features = defineFeatures([
    {
      id: 'reentrant',
      configKey: 'quoteReply',
      reversible: true,
      mount(ctx, env) {
        log.mounts.reentrant = (log.mounts.reentrant ?? 0) + 1
        container.feedSync({ quoteReply: true })
        env.track(() => {})
      },
    },
  ])

  container = createContainer({
    features,
    ctx: {},
    env: {},
    readSwitches: () => Promise.resolve({ quoteReply: true }),
    cachedSwitches: () => ({}),
    watchSwitches: () => () => {},
    onError: () => {},
  })

  await container.ready()
  await flush()
  assert.equal(log.mounts.reentrant, 1, 'the mounting placeholder blocks the second mount')
  assert.equal(container.phaseOf('reentrant'), 'mounted')
  container.dispose()
})

test('I3: a feature that only returns a disposer (no env.track) is still unmounted', async () => {
  const log = { mounts: {}, disposals: {} }
  const features = defineFeatures([
    {
      id: 'returns-disposer',
      configKey: 'quoteReply',
      reversible: true,
      mount() {
        log.mounts.r = (log.mounts.r ?? 0) + 1
        return () => {
          log.disposals.r = (log.disposals.r ?? 0) + 1
        }
      },
    },
  ])

  const container = createContainer({
    features,
    ctx: {},
    env: {},
    readSwitches: () => Promise.resolve({ quoteReply: true }),
    cachedSwitches: () => ({}),
    watchSwitches: () => () => {},
    onError: () => {},
  })

  await container.ready()
  assert.equal(container.phaseOf('returns-disposer'), 'mounted')
  container.feed({ quoteReply: false })
  await container.settled()
  assert.equal(log.disposals.r, 1, 'the returned disposer is called on toggle-off')
  assert.equal(container.liveCount(), 0)
  container.dispose()
})

test('a mount that throws is rolled back and does not block the others', async () => {
  const log = { mounts: {}, disposals: {} }
  const errors = []
  const features = defineFeatures([
    {
      id: 'bad',
      configKey: 'quoteReply',
      reversible: true,
      mount(ctx, env) {
        env.track(() => {
          log.disposals.beforeThrow = 1
        })
        throw new Error('kaboom')
      },
    },
    probeFeature('good', 'panelMenu', true, log),
  ])

  const container = createContainer({
    features,
    ctx: {},
    env: {},
    readSwitches: () => Promise.resolve(ALL),
    cachedSwitches: () => ({}),
    watchSwitches: () => () => {},
    onError: (id, error) => errors.push([id, error.message]),
  })

  await container.ready()
  assert.equal(log.disposals.beforeThrow, 1, 'partially registered effects are undone')
  assert.equal(container.phaseOf('bad'), 'off')
  assert.equal(container.phaseOf('good'), 'mounted', 'one bad feature does not stop the rest')
  assert.equal(errors.length, 1)
  container.dispose()
})

test('dispose after the truth resolved must never mount through a late promise', async () => {
  const log = { mounts: {}, disposals: {} }
  let resolveTruth
  const truth = new Promise((resolve) => {
    resolveTruth = resolve
  })
  const features = defineFeatures([probeFeature('late', 'quoteReply', true, log)])
  const container = createContainer({
    features,
    ctx: {},
    env: {},
    readSwitches: () => truth,
    cachedSwitches: () => ({}),
    watchSwitches: () => () => {},
    onError: () => {},
  })
  container.dispose()
  resolveTruth({ quoteReply: true })
  await flush()
  assert.equal(log.mounts.late, undefined, 'a disposed container never mounts')
})

test('P1-5: an async fiber disposal settles through the container without an unhandled rejection', async () => {
  const rejections = []
  const onRejection = (error) => rejections.push(error)
  process.on('unhandledRejection', onRejection)

  let resolved = false
  const features = defineFeatures([
    {
      id: 'fiber',
      configKey: 'quoteReply',
      reversible: true,
      mount(ctx, env) {
        env.track({
          dispose: () =>
            new Promise((_resolve, reject) => {
              setTimeout(() => {
                resolved = true
                reject(new Error('fiber dispose failed'))
              }, 5)
            }),
        })
      },
    },
  ])

  const container = createContainer({
    features,
    ctx: {},
    env: {},
    readSwitches: () => Promise.resolve({ quoteReply: true }),
    cachedSwitches: () => ({}),
    watchSwitches: () => () => {},
    onError: () => {},
  })

  await container.ready()
  assert.equal(container.phaseOf('fiber'), 'mounted')
  container.feed({ quoteReply: false })
  await container.settled()
  await new Promise((resolve) => setTimeout(resolve, 20))

  process.off('unhandledRejection', onRejection)
  assert.equal(resolved, true, 'the async disposal ran')
  assert.equal(rejections.length, 0, 'the rejection was caught by the scope')
  assert.equal(container.phaseOf('fiber'), 'off')
  container.dispose()
})
