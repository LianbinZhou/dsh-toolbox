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

test('adapter · no registry degrades to READ-ONLY instead of hiding the list', () => {
  const adapter = createSessionAdapter({ sessions: {}, storageFallback: () => [ID] })
  assert.ok(adapter, 'the list must still work')
  assert.equal(adapter.readOnly, true)
  assert.deepEqual(adapter.readArchived(), [ID], 'the ids come from the persisted unit')
  assert.throws(() => adapter.unarchive(ID), /unarchive is disabled/, 'unarchive needs the registry')
})

test('adapter · the archived set is re-read on every call, never cached', () => {
  const reg = registry()
  const adapter = createSessionAdapter({ registry: reg, sessions: {}, sessionsRoot: 'C:/tmp/sessions', storageFallback: () => [] })
  assert.deepEqual(adapter.readArchived(), [ID])
  reg.archivedSessionIds.add('session-bbbbbbbb-1111-2222-3333-444444444444')
  assert.equal(adapter.readArchived().length, 2, 'a snapshot cached at construction would hide the new id')
})

test('adapter · live comes from sessions.get, and an unknown state refuses', () => {
  const open = createSessionAdapter({ registry: registry(), sessions: { get: () => ({ id: ID }) }, sessionsRoot: 'C:/tmp/sessions', storageFallback: () => [] })
  assert.equal(open.isLive(ID), true)

  const closed = createSessionAdapter({ registry: registry(), sessions: { get: () => undefined }, sessionsRoot: 'C:/tmp/sessions', storageFallback: () => [] })
  assert.equal(closed.isLive(ID), false)

  const broken = createSessionAdapter({ registry: registry(), sessions: { get() { throw new Error('boom') } }, sessionsRoot: 'C:/tmp/sessions', storageFallback: () => [] })
  assert.equal(broken.isLive(ID), true, 'a throwing live check must refuse the delete, not allow it')

  const missing = createSessionAdapter({ registry: registry(), sessions: undefined, sessionsRoot: 'C:/tmp/sessions', storageFallback: () => [] })
  assert.equal(missing.isLive(ID), true, 'no sessions service => cannot prove it is dead => refuse')
})

test('adapter · unarchive goes through the registry, not storage', () => {
  const reg = registry()
  const adapter = createSessionAdapter({ registry: reg, sessions: {}, sessionsRoot: 'C:/tmp/sessions', storageFallback: () => [] })
  adapter.unarchive(ID)
  assert.equal(reg.archivedSessionIds.has(ID), false)
})

test('adapter · a null getter yields an empty list instead of throwing', () => {
  const adapter = createSessionAdapter({ registry: registry({ archivedSessionIds: null }), sessions: {}, sessionsRoot: 'C:/tmp/sessions', storageFallback: () => [] })
  assert.deepEqual(adapter.readArchived(), [])
})

test('adapter · usable means read + live + probe', () => {
  const good = createSessionAdapter({ registry: registry(), sessions: {}, sessionsRoot: 'C:/tmp/sessions', storageFallback: () => [] })
  assert.equal(adapterIsUsable(good), true)
  assert.equal(adapterIsUsable({ readArchived() {}, isLive() {}, probe() {} }), true, 'a read-only adapter is enough for the list')
  assert.equal(adapterIsUsable({ readArchived() {}, isLive() {} }), false, 'no probe => not usable')
})


test('adapter · a FUNCTION form of the getter is read too', () => {
  const reg = registry({ archivedSessionIds: () => [ID] })
  const adapter = createSessionAdapter({ registry: reg, sessions: {}, sessionsRoot: 'C:/tmp/sessions', storageFallback: () => [] })
  assert.deepEqual(adapter.readArchived(), [ID], 'a method form must not silently read as empty')
})

test('adapter · an OBSERVABLE form of the getter is read too', () => {
  const reg = registry({ archivedSessionIds: { getSnapshot: () => new Set([ID]) } })
  const adapter = createSessionAdapter({ registry: reg, sessions: {}, sessionsRoot: 'C:/tmp/sessions', storageFallback: () => [] })
  assert.deepEqual(adapter.readArchived(), [ID])
})
