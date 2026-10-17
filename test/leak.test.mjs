/**
 * Leak counting: toggling ten times must leave nothing behind.
 *
 * Every feature registers one listener through `env.track`; the fake host counts
 * how many are live. If a scope is dropped, a generation is not restored, or a
 * disposer is skipped, the count stays above zero and this test fails.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createContainer } from '../src/client/container.js'
import { createFeatures, createFeatureProbe } from '../src/client/features.js'

function makeHost() {
  const live = new Set()
  let next = 0
  return {
    addListener(id) {
      const token = ++next
      live.add(token)
      return () => {
        live.delete(token)
      }
    },
    liveCount: () => live.size,
  }
}

test('ten on/off cycles leave no live effect and no live scope', async () => {
  const probe = createFeatureProbe()
  const host = makeHost()
  const features = createFeatures(probe, host)
  const values = {
    quoteReply: true,
    draftSaver: true,
    panelMenu: true,
    archivePanel: true,
    pluginZh: true,
    sessionSearch: true,
  }

  const container = createContainer({
    features,
    ctx: {},
    env: {},
    readSwitches: () => Promise.resolve(values),
    cachedSwitches: () => ({}),
    watchSwitches: () => () => {},
    onError: (id, error) => {
      throw new Error('unexpected error from ' + id + ': ' + error.message)
    },
  })

  await container.ready()
  assert.equal(container.liveCount(), 5)
  assert.equal(host.liveCount(), 5)

  for (let round = 0; round < 10; round += 1) {
    container.feed({
      quoteReply: false,
      draftSaver: false,
      panelMenu: false,
      archivePanel: false,
      pluginZh: false,
      sessionSearch: false,
    })
    await container.settled()
    assert.equal(container.liveCount(), 0, 'round ' + round + ': every scope is closed')
    assert.equal(host.liveCount(), 0, 'round ' + round + ': every listener is removed')

    container.feed(values)
    await container.settled()
    assert.equal(container.liveCount(), 5, 'round ' + round + ': everything comes back')
    assert.equal(host.liveCount(), 5, 'round ' + round + ': no duplicated listener')
  }

  container.dispose()
  assert.equal(container.liveCount(), 0)
  assert.equal(host.liveCount(), 0)
})
