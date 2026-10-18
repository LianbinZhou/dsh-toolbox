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
  // 会话对象在内存里 ≠ 在跑：以前这条断言「有对象就算活」，导致
  // 打开过的会话永远删不掉（真机 running=false 仍报 session-is-live）。
  const loadedButIdle = createSessionAdapter({ registry: registry(), sessions: { get: () => ({ id: ID, running: false }) }, sessionsRoot: 'C:/tmp/sessions', storageFallback: () => [] })
  assert.equal(loadedButIdle.isLive(ID), false, '加载了但没在跑，不该拦')

  const running = createSessionAdapter({ registry: registry(), sessions: { get: () => ({ id: ID, running: true }) }, sessionsRoot: 'C:/tmp/sessions', storageFallback: () => [] })
  assert.equal(running.isLive(ID), true, '真在跑才拒绝')

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


test('adapter · a THROWING getter falls back to the persisted unit, not an empty list', () => {
  const broken = createSessionAdapter({
    registry: {
      get archivedSessionIds() {
        throw new Error('cannot get property without inject')
      },
    },
    sessions: {},
    sessionsRoot: 'C:/tmp/sessions',
    storageFallback: () => [ID],
  })
  assert.deepEqual(broken.readArchived(), [ID], 'a throwing seam must not look like an empty archive')
})

/* ------------------------------------------------------------------ *
 * 快照与摘行的回归                                                     *
 *                                                                     *
 * 这两条路径以前没有任何测试：registry 没有 list() 时 snapshotWorkspace *
 * 会提前 return，于是「用了却没导入的 canonicalSessionId」永远走不到，   *
 * 381 项全绿、真机一删却 ReferenceError。下面的 registry 带 list()，    *
 * 把这条路径逼出来；entity.sessionIds 被故意做成会抛，证明两者都只读     *
 * 原始 record，不碰 filtered getter。                                  *
 * ------------------------------------------------------------------ */

function entityRegistry(sessionIds) {
  const record = { sessionIds: [...sessionIds] }
  const entity = {
    id: 'ws-1',
    record,
    get sessionIds() {
      throw new Error('filtered getter must not be used')
    },
    async detachSession(id) {
      record.sessionIds = record.sessionIds.filter((value) => value !== id)
    },
  }
  return {
    archivedSessionIds: new Set(sessionIds),
    list: () => [entity],
    unarchiveSession() {},
  }
}

test('adapter · snapshotWorkspace reads the raw record, never the throwing getter', () => {
  const adapter = createSessionAdapter({
    registry: entityRegistry([ID]),
    sessions: {},
    sessionsRoot: 'C:/tmp/sessions',
    storageFallback: () => [],
  })
  const seat = adapter.snapshotWorkspace(ID)
  assert.ok(seat, 'a snapshot must be produced')
  assert.equal(seat.workspaceId, 'ws-1')
  assert.equal(seat.sessionId, ID)
})

test('adapter · dropWorkspaceRows honours the snapshot and uses detachSession', async () => {
  const reg = entityRegistry([ID])
  const adapter = createSessionAdapter({
    registry: reg,
    sessions: {},
    sessionsRoot: 'C:/tmp/sessions',
    storageFallback: () => [],
  })
  const result = await adapter.dropWorkspaceRows(ID, { workspaceId: 'ws-1' })
  assert.equal(result.ok, true)
  assert.equal(result.dropped, 1, 'the row must be detached')
  assert.deepEqual(reg.list()[0].record.sessionIds, [], 'the record no longer holds it')
})
