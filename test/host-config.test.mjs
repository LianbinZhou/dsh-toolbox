/**
 * P0-1 / P1-2: the root-object volatile shape and the fail-closed rule, measured
 * with the real schemastery.
 *
 * The trap: with `.volatile()` on the whole object, `config.sessionSearch` is
 * `undefined`, so `config.sessionSearch.get()` throws. A throw inside
 * `tools.guard` would become a tool error for EVERY tool.
 *
 * The rule the S1 review enforced: a missing key or an unreadable config is OFF.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, isOn, readConfig } from '../src/host/config.js'

const ALL_ON = {
  quoteReply: true,
  draftSaver: true,
  panelMenu: true,
  archivePanel: true,
  pluginZh: true,
  sessionSearch: true,
  archiveHttpApi: true,
  trashKeptDays: 7,
}

test('the schema is a volatile root: config.get() has the values', () => {
  const config = Config(ALL_ON)
  const values = config.get()
  assert.equal(values.sessionSearch, true)
  assert.equal(values.pluginZh, true)
})

test('the trap is real: a field on the volatile root is undefined', () => {
  const config = Config(ALL_ON)
  assert.equal(config.sessionSearch, undefined, 'config.sessionSearch is NOT a boolean')
  assert.throws(() => config.sessionSearch.get(), TypeError, 'and calling .get() on it throws')
})

test('readConfig tolerates a volatile ref, a plain object, null and a throwing ref', () => {
  assert.deepEqual(readConfig(Config(ALL_ON)), ALL_ON)
  assert.deepEqual(readConfig(ALL_ON), ALL_ON)
  assert.deepEqual(readConfig(undefined), {})
  assert.deepEqual(readConfig(null), {})
  assert.deepEqual(
    readConfig({
      get() {
        throw new Error('boom')
      },
    }),
    {},
  )
})

test('P1-2: isOn fails closed — a missing key is OFF', () => {
  assert.equal(isOn({}, 'sessionSearch'), false, 'a missing key must not switch a feature on')
  assert.equal(isOn({}, 'sessionSearch', true), true, 'only an explicit fallback opts into on')
  assert.equal(isOn(undefined, 'pluginZh'), false)
})

test('P1-2: an unreadable config is OFF, not ON', () => {
  const broken = {
    get() {
      throw new Error('config exploded')
    },
  }
  assert.equal(isOn(broken, 'sessionSearch'), false)
})

test('isOn re-reads every call, so an in-place update is seen', () => {
  let current = { sessionSearch: true }
  const ref = { get: () => current }
  assert.equal(isOn(ref, 'sessionSearch'), true)
  current = { sessionSearch: false }
  assert.equal(isOn(ref, 'sessionSearch'), false, 'no destructured cache may freeze the value')
})

test('isOn honours an explicit false from the real volatile schema', () => {
  const config = Config(Object.assign({}, ALL_ON, { pluginZh: false }))
  assert.equal(isOn(config, 'pluginZh'), false)
  assert.equal(isOn(config, 'quoteReply'), true)
})
