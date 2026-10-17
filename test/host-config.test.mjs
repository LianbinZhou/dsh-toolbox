/**
 * P0-1: the root-object volatile shape, measured with the real schemastery.
 *
 * The trap this test locks down: with `.volatile()` on the whole object,
 * `config.sessionSearch` is `undefined`, so `config.sessionSearch.get()` throws.
 * If that throw happened inside `tools.guard`, every tool call would become a
 * tool error. The guard must read through `isOn(config, key)` and never throw.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, isOn, readConfig } from '../src/host/config.js'
import { makeGuard, GUARDED_TOOL } from '../src/host/index.js'

const ALL_ON = {
  quoteReply: true,
  draftSaver: true,
  panelMenu: true,
  archivePanel: true,
  pluginZh: true,
  sessionSearch: true,
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

test('isOn re-reads every call, so an in-place update is seen', () => {
  // The real volatile ref freezes its value object, so simulate the in-place
  // swap the loader performs: get() answers with the current object each call.
  let current = { sessionSearch: true }
  const ref = { get: () => current }
  assert.equal(isOn(ref, 'sessionSearch'), true)
  current = { sessionSearch: false }
  assert.equal(isOn(ref, 'sessionSearch'), false, 'no destructured cache may freeze the value')
})

test('isOn falls back to the schema default for a missing key', () => {
  assert.equal(isOn({}, 'sessionSearch'), true)
  assert.equal(isOn({}, 'sessionSearch', false), false)
})

test('the guard never throws, for any input shape', () => {
  const guard = makeGuard(Config(ALL_ON))
  for (const input of [undefined, null, {}, { name: 'other_tool' }, { name: GUARDED_TOOL }]) {
    assert.doesNotThrow(() => guard(input))
  }
  const broken = makeGuard({
    get() {
      throw new Error('config exploded')
    },
  })
  assert.doesNotThrow(() => broken({ name: GUARDED_TOOL }))
  assert.equal(broken({ name: GUARDED_TOOL }), undefined, 'a failing read must not deny')
})

test('the guard only touches its own tool (never a global deny)', () => {
  const guard = makeGuard({ sessionSearch: false })
  assert.equal(guard({ name: 'some_other_tool' }), undefined, 'unrelated tools stay allowed')
  assert.equal(guard({ name: 'read' }), undefined)
  const denial = guard({ name: GUARDED_TOOL })
  assert.equal(typeof denial, 'string')
  assert.match(denial, /switched off/)
  assert.match(denial, /[Dd]o not retry/)
})

test('an enabled switch yields no denial', () => {
  const guard = makeGuard({ sessionSearch: true })
  assert.equal(guard({ name: GUARDED_TOOL }), undefined)
})
