/**
 * 4.4 / 4.3：两个真实中间态。
 *
 * 4.4 曾经的问题：cleanup 失败 → 状态停在 trashed、归档标记还在；
 *      恢复文件后没补清标记，下次又被当成归档会话。
 * 4.3 曾经的问题：trashed 被当成垃圾物理清掉，文件没了、标记还在，变幽灵。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createArchiveService } from '../src/host/features/archive/service.js'
import { sweepExpiredTrash } from '../src/host/features/archive/trash-sweep.js'
import { makeWorld, ID_A } from './support/archive-service-matrix.mjs'

const TRASH = 'C:/home/storages/archive-trash'

test('4.4 · cleanup 失败后恢复，归档标记必须被补清', async () => {
  const { deps, world } = makeWorld({ failAt: { step: 'workspace', error: new Error('down') } })
  const service = createArchiveService(deps)

  const removed = await service.delete(ID_A)
  assert.equal(removed.ok, true, '删除本身应成功')
  assert.equal(world.journalEntries()[0].phase, 'trashed', 'cleanup 失败会停在 trashed')
  // cleanup 现在先清归档标记、再摘工作区行：行失败会停在 trashed，
  // 但标记已经清掉了（否则归档页会一直指着一个空目录）。
  assert.equal(world.archived.has(ID_A), false, '标记在 cleanup 第一步就清了，不随行失败回滚')

  // 解除故障注入，模拟「下次重试时环境正常」
  deps.unarchive = (id) => {
    world.archived.delete(id)
  }

  const back = await service.unarchiveSession(ID_A)
  assert.equal(back.ok, true)
  assert.equal(world.archived.has(ID_A), false, '恢复后归档标记必须清掉，否则下次又被当归档')
})

test('4.3 · trashed 超过保留期也不许物理清空', async () => {
  const old = { id: ID_A, nonce: 'n1', phase: 'trashed', originalPath: 'C:/home/sessions/projA/' + ID_A, trashPath: TRASH + '/n1', dev: 1, ino: 1, at: 1 }
  const { deps, world } = makeWorld({ journal: [old], failAt: { step: 'workspace', error: new Error('down') } })
  world.trash.set(TRASH + '/n1', ID_A)
  const service = createArchiveService(deps)

  const result = await sweepExpiredTrash({ journal: deps.journal, service, ttlDays: 7, now: Date.now() })
  assert.equal(result.purged, 0, 'trashed 是待办，不是垃圾')
  assert.equal(world.trash.has(TRASH + '/n1'), true, '文件不能消失')
  // 记录停在 trashed（行没摘掉），但归档标记在 cleanup 第一步已清。
  assert.equal(world.archived.has(ID_A), false, 'marker cleared in cleanup, file kept for retry')
})

test('4.3 · cleaned 超过保留期照常清空', async () => {
  const old = { id: ID_A, nonce: 'n1', phase: 'cleaned', originalPath: 'C:/home/sessions/projA/' + ID_A, trashPath: TRASH + '/n1', dev: 1, ino: 1, at: 1 }
  const { deps, world } = makeWorld({ journal: [old] })
  world.trash.set(TRASH + '/n1', ID_A)
  const service = createArchiveService(deps)

  const result = await sweepExpiredTrash({ journal: deps.journal, service, ttlDays: 7, now: Date.now() })
  assert.equal(result.purged, 1, 'cleaned 到期就该清')
  assert.equal(world.trash.has(TRASH + '/n1'), false)
})


test('heal · cleaned 且无 lastError 是终态，绝不重试（防空转）', async () => {
  const done = { id: ID_A, nonce: 'n1', phase: 'cleaned', originalPath: 'C:/home/sessions/projA/' + ID_A, trashPath: TRASH + '/n1', dev: 1, ino: 1, at: 1 }
  const { deps, world } = makeWorld({ journal: [done] })
  world.trash.set(TRASH + '/n1', ID_A)
  const service = createArchiveService(deps)

  const result = await service.heal()
  assert.equal(result.ok, true)
  assert.equal(world.calls.workspace.length, 0, '终态记录不许再 detach 一次（真机那串 60→60 就是空转）')
  assert.equal(world.calls.unarchive.length, 0, '也不许再清标记')
  assert.equal(world.journalEntries()[0].phase, 'cleaned', '状态不变')
})

test('heal · 带 lastError 的 cleaned 仍要重试（上次没清完）', async () => {
  const stuck = { id: ID_A, nonce: 'n1', phase: 'cleaned', originalPath: 'C:/home/sessions/projA/' + ID_A, trashPath: TRASH + '/n1', dev: 1, ino: 1, at: 1, lastError: 'workspace:not-found' }
  const { deps, world } = makeWorld({ journal: [stuck] })
  world.trash.set(TRASH + '/n1', ID_A)
  world.archived.add(ID_A)
  const service = createArchiveService(deps)

  await service.heal()
  assert.ok(world.calls.workspace.length > 0, '带 lastError 的必须重试')
})
