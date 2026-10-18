/**
 * S4 终审补测（P0-1 / P0-2 / P1-1 / P1-2 + 可见性）。
 *
 * 这七条对应 `20261018-1831-S4封板终审.md` 第 4 节列出的缺口。它们故意
 * 落在「上一轮没测的生效路径」上：
 *
 *   1. 快照 seat 真的进了 journal claim；
 *   2. dropped === 0 必须被当成 cleanup 失败，不许标 cleaned；
 *   3. detachSession 必须用快照里的真实拼写（bare / session- 前缀）；
 *   4. reattach 必须先 attach 再 insertBefore，否则永远回不到原位；
 *   5. 普通归档恢复必须 await 慢 unarchive；
 *   6. purge 前 cleanup 失败时，文件一个都不许删；
 *   7. lastError / cleanupAttempts 必须送到 UI（listTrash）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionAdapter } from '../src/host/features/archive/session-adapter.js'
import { createArchiveService } from '../src/host/features/archive/service.js'
import { makeWorld } from './support/archive-service-matrix.mjs'

const ID = 'session-aaaaaaaa-1111-2222-3333-444444444444'
const BARE = 'aaaaaaaa-1111-2222-3333-444444444444'

/* ------------------------------------------------------------------ *
 * 1 · 快照 seat 写进 claim                                             *
 * ------------------------------------------------------------------ */

test('P0 · the workspace snapshot is durable inside the journal claim', async () => {
  const { deps } = makeWorld()
  deps.snapshotWorkspace = () => ({ workspaceId: 'ws-1', sessionId: ID, beforeSessionId: null })
  const service = createArchiveService(deps)
  await service.delete(ID)
  const entry = deps.journal.read().find((row) => row.id === ID)
  assert.ok(entry, 'the claim must exist')
  assert.equal(entry.workspaceSeat?.workspaceId, 'ws-1', 'seat must survive in the claim')
  assert.equal(entry.workspaceSeat?.sessionId, ID)
})

/* ------------------------------------------------------------------ *
 * 2 · dropped === 0 是失败，不是成功                                   *
 * ------------------------------------------------------------------ */

test('P0 · a drop that removes nothing is a cleanup failure, not a success', async () => {
  const { deps } = makeWorld()
  // 最典型的假成功：方法没抛、返回 ok，但一行都没摘。
  deps.dropWorkspaceRows = () => ({ ok: true, dropped: 0 })
  const service = createArchiveService(deps)
  const result = await service.delete(ID)

  const entry = deps.journal.read().find((row) => row.id === ID)
  assert.equal(entry.phase, 'trashed', 'must NOT claim cleaned')
  assert.match(String(entry.lastError), /dropped-0/, 'the reason must be recorded')
  assert.equal(entry.cleanupAttempts, 1)
  assert.equal(result.warning, 'deleted with warnings')
})

/* ------------------------------------------------------------------ *
 * 3 · detachSession 必须用快照的真实拼写                               *
 * ------------------------------------------------------------------ */

test('P0 · detachSession receives the stored spelling, not the request id', async () => {
  const calls = []
  const record = { sessionIds: [BARE] } // 工作区里存的是裸 id
  const entity = {
    id: 'ws-1',
    record,
    async detachSession(id) {
      calls.push(id)
      // 真实方法按精确匹配删除：传错拼写就是什么都不删。
      record.sessionIds = record.sessionIds.filter((row) => row !== id)
    },
  }
  const registry = { archivedSessionIds: new Set([ID]), list: () => [entity], unarchiveSession() {} }
  const adapter = createSessionAdapter({ registry, sessions: {}, sessionsRoot: 'C:/tmp/sessions', storageFallback: () => [] })

  const result = await adapter.dropWorkspaceRows(ID, { workspaceId: 'ws-1', sessionId: BARE })
  assert.equal(result.ok, true)
  assert.equal(result.dropped, 1)
  assert.deepEqual(calls, [BARE], 'must pass the snapshot spelling')
  assert.deepEqual(record.sessionIds, [], 'the row must really be gone')
})

test('P0 · a detach that leaves the row behind is reported as failure', async () => {
  const record = { sessionIds: [ID] }
  const entity = {
    id: 'ws-1',
    record,
    // 幂等但没生效：这正是前缀不一致时的真实表现。
    async detachSession() {},
  }
  const registry = { archivedSessionIds: new Set([ID]), list: () => [entity], unarchiveSession() {} }
  const adapter = createSessionAdapter({ registry, sessions: {}, sessionsRoot: 'C:/tmp/sessions', storageFallback: () => [] })

  const result = await adapter.dropWorkspaceRows(ID, { workspaceId: 'ws-1', sessionId: ID })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'detach-no-effect')
})

/* ------------------------------------------------------------------ *
 * 4 · reattach 顺序：先挂载、再定位                                    *
 * ------------------------------------------------------------------ */

test('P1 · reattach attaches first, then restores the original position', async () => {
  const order = []
  const record = { sessionIds: ['session-b'] }
  const entity = {
    id: 'ws-1',
    record,
    async attachSession(id) {
      order.push('attach:' + id)
      record.sessionIds = [...record.sessionIds, id]
    },
    async insertSessionBefore(id, before) {
      order.push('insert:' + id + '<' + before)
      record.sessionIds = record.sessionIds.filter((row) => row !== id)
      const at = record.sessionIds.indexOf(before)
      record.sessionIds.splice(at < 0 ? record.sessionIds.length : at, 0, id)
    },
  }
  const registry = { archivedSessionIds: new Set(), list: () => [entity], unarchiveSession() {} }
  const adapter = createSessionAdapter({ registry, sessions: {}, sessionsRoot: 'C:/tmp/sessions', storageFallback: () => [] })

  const result = await adapter.reattach({ workspaceId: 'ws-1', sessionId: 'session-a', beforeSessionId: 'session-b' })
  assert.equal(result.ok, true)
  assert.deepEqual(order, ['attach:session-a', 'insert:session-a<session-b'], 'attach must come first')
  assert.deepEqual(record.sessionIds, ['session-a', 'session-b'], 'the original order must be restored')
})

/* ------------------------------------------------------------------ *
 * 5 · 普通归档恢复必须 await 慢 unarchive                              *
 * ------------------------------------------------------------------ */

test('P1 · a delayed unarchive is awaited before the restore answers', async () => {
  const { deps, world } = makeWorld()
  let settled = false
  deps.unarchive = async (id) => {
    await new Promise((resolve) => setTimeout(resolve, 30))
    world.calls.unarchive.push(id)
    world.archived.delete(id)
    settled = true
  }
  const service = createArchiveService(deps)
  const result = await service.unarchiveSession(ID)
  assert.equal(result.ok, true)
  assert.equal(settled, true, 'the call must not answer before unarchive settles')
  assert.equal(world.calls.unarchive.length, 1)
})

/* ------------------------------------------------------------------ *
 * 6 · purge 前 cleanup 失败 -> 文件不许删                              *
 * ------------------------------------------------------------------ */

test('P0 · purge refuses to remove files while cleanup is still pending', async () => {
  const { deps, world } = makeWorld()
  deps.dropWorkspaceRows = () => ({ ok: true, dropped: 1 })
  const service = createArchiveService(deps)
  await service.delete(ID) // 顺利入箱

  // 之后工作区行又出问题：彻底删除必须先补清账务。
  deps.dropWorkspaceRows = () => ({ ok: false, reason: 'workspace-row-missing' })
  const result = await service.purge(ID)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'cleanup-pending')
  assert.equal(world.calls.removeTree.length, 0, 'no file may be removed')
})

/* ------------------------------------------------------------------ *
 * 7 · lastError / cleanupAttempts 必须送到 UI                          *
 * ------------------------------------------------------------------ */

test('P1 · listTrash exposes lastError and cleanupAttempts for the UI', async () => {
  const { deps } = makeWorld()
  deps.dropWorkspaceRows = () => ({ ok: false, reason: 'workspace-row-missing' })
  const service = createArchiveService(deps)
  await service.delete(ID)

  const listed = service.listTrash()
  const row = listed.rows.find((item) => item.id === ID)
  assert.ok(row, 'the entry must be listed')
  assert.match(String(row.lastError), /workspace-row-missing/)
  assert.equal(row.cleanupAttempts, 1)
})
