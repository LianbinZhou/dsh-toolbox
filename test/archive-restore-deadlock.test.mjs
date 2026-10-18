/**
 * P0：删除后立刻恢复，不能死锁；两种垃圾箱状态都要覆盖。
 *
 * withLock 不可重入：同一个 id 在锁内再调一次 withLock(id) 会等「自己」，
 * 于是永久挂起。用 1 秒超时把死锁变成红灯。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createArchiveService } from '../src/host/features/archive/service.js'
import { makeWorld, ID_A } from './support/archive-service-matrix.mjs'

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('__timeout__'), ms))])
}

test('P0 · 删除后立刻恢复不会死锁（cleaned 态）', async () => {
  const { deps, world } = makeWorld()
  const service = createArchiveService(deps)

  const removed = await service.delete(ID_A)
  assert.equal(removed.ok, true)
  assert.equal(world.journalEntries()[0].phase, 'cleaned', '删除后应停在 cleaned')

  const result = await withTimeout(service.unarchiveSession(ID_A), 1000)
  assert.notEqual(result, '__timeout__', '恢复卡死：unarchiveSession 在锁内又调了带锁的 restore')
  assert.equal(result.ok, true)
  assert.equal(world.dirExists(ID_A), true, '文件应回到原位')
})

test('P0 · trashed 态（还没清理完）也能恢复且不死锁', async () => {
  const { deps, world } = makeWorld()
  const service = createArchiveService(deps)

  // 删除，但把记录卡在 trashed：模拟「移动完成、清理未做」的中间态
  await service.delete(ID_A)
  const entries = deps.journal.read()
  deps.journal.write(entries.map((entry) => ({ ...entry, phase: 'trashed' })))

  const result = await withTimeout(service.unarchiveSession(ID_A), 1000)
  assert.notEqual(result, '__timeout__', 'trashed 态恢复卡死')
  assert.equal(result.ok, true)
  assert.equal(world.dirExists(ID_A), true)
})

test('P0 · 恢复之后锁已释放（同 id 再删立即返回，不挂起）', async () => {
  const { deps } = makeWorld()
  const service = createArchiveService(deps)
  await service.delete(ID_A)
  await service.unarchiveSession(ID_A)

  const again = await withTimeout(service.delete(ID_A), 1000)
  assert.notEqual(again, '__timeout__', '锁没有释放')
  // 恢复后它已不在归档集合里，所以应立刻被拒绝，而不是再删一次
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'not-archived')
})
