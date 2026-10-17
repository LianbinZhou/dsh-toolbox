/**
 * S4-c · the session adapter contract.
 *
 * Each assertion pins one of Pi's rulings: the archived set is the registry
 * getter (re-read every time, never cached), live is `sessions.get`, and every
 * failure mode fails CLOSED (no adapter, or "treat it as live and refuse").
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionAdapter, adapterIsUsable } from '../src/host/features/archive/session-adapter.js'

const ID = 'session-aaaaaaaa-1111-2222-3333-444444444444'

function registry(overrides = {}) {
  return {
    archivedSessionIds: new Set([ID]),
    unarchiveSession(id) {
      this.archivedSessionIds.delete(id)
    },
    ...overrides,
  }
}

test('adapter · no workspaceRegistry means NO adapter (fail closed)', () => {
  assert.equal(createSessionAdapter({ sessions: {} }), null)
  assert.equal(createSessionAdapter({ registry: {} }), null, 'a registry without unarchiveSession is not enough')
  assert.equal(adapterIsUsable(null), false)
})

test('adapter · the archived set is re-read on every call, never cached', () => {
  const reg = registry()
  const adapter = createSessionAdapter({ registry: reg, sessions: {}, sessionsRoot: 'C:/tmp/sessions' })
  assert.deepEqual(adapter.readArchived(), [ID])
  reg.archivedSessionIds.add('session-bbbbbbbb-1111-2222-3333-444444444444')
  assert.equal(adapter.readArchived().length, 2, 'a snapshot cached at construction would hide the new id')
})

test('adapter · live comes from sessions.get, and an unknown state refuses', () => {
  const open = createSessionAdapter({ registry: registry(), sessions: { get: () => ({ id: ID }) }, sessionsRoot: 'C:/tmp/sessions' })
  assert.equal(open.isLive(ID), true)

  const closed = createSessionAdapter({ registry: registry(), sessions: { get: () => undefined }, sessionsRoot: 'C:/tmp/sessions' })
  assert.equal(closed.isLive(ID), false)

  const broken = createSessionAdapter({ registry: registry(), sessions: { get() { throw new Error('boom') } }, sessionsRoot: 'C:/tmp/sessions' })
  assert.equal(broken.isLive(ID), true, 'a throwing live check must refuse the delete, not allow it')

  const missing = createSessionAdapter({ registry: registry(), sessions: undefined, sessionsRoot: 'C:/tmp/sessions' })
  assert.equal(missing.isLive(ID), true, 'no sessions service => cannot prove it is dead => refuse')
})

test('adapter · unarchive goes through the registry, not storage', () => {
  const reg = registry()
  const adapter = createSessionAdapter({ registry: reg, sessions: {}, sessionsRoot: 'C:/tmp/sessions' })
  adapter.unarchive(ID)
  assert.equal(reg.archivedSessionIds.has(ID), false)
})

test('adapter · a null getter yields an empty list instead of throwing', () => {
  const adapter = createSessionAdapter({ registry: registry({ archivedSessionIds: null }), sessions: {}, sessionsRoot: 'C:/tmp/sessions' })
  assert.deepEqual(adapter.readArchived(), [])
})

test('adapter · is usable only when every required member exists', () => {
  const good = createSessionAdapter({ registry: registry(), sessions: {}, sessionsRoot: 'C:/tmp/sessions' })
  assert.equal(adapterIsUsable(good), true)
  assert.equal(adapterIsUsable({ readArchived() {}, isLive() {}, probe() {} }), false, 'no unarchive => not usable')
})


test('adapter · a FUNCTION form of the getter is read too', () => {
  const reg = registry({ archivedSessionIds: () => [ID] })
  const adapter = createSessionAdapter({ registry: reg, sessions: {}, sessionsRoot: 'C:/tmp/sessions' })
  assert.deepEqual(adapter.readArchived(), [ID], 'a method form must not silently read as empty')
})

test('adapter · an OBSERVABLE form of the getter is read too', () => {
  const reg = registry({ archivedSessionIds: { getSnapshot: () => new Set([ID]) } })
  const adapter = createSessionAdapter({ registry: reg, sessions: {}, sessionsRoot: 'C:/tmp/sessions' })
  assert.deepEqual(adapter.readArchived(), [ID])
})
