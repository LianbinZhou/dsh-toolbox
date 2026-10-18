/**
 * 回收箱要显示会话名，不只是 id 尾段。
 *
 * 删除后会话已不在归档集合里，标题只能靠删除时记进 journal。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createArchiveService } from '../src/host/features/archive/service.js'
import { makeWorld, ID_A } from './support/archive-service-matrix.mjs'

test('标题 · 删除时记进 journal，回收箱列表能拿到', async () => {
  const { deps } = makeWorld()
  const service = createArchiveService(deps)

  const removed = await service.delete(ID_A, { title: 'GitHub 访问地址那条会话' })
  assert.equal(removed.ok, true)

  const trash = service.listTrash()
  assert.equal(trash.ok, true)
  const row = trash.rows.find((entry) => entry.id === ID_A)
  assert.ok(row, '回收箱里必须有这条')
  assert.equal(row.title, 'GitHub 访问地址那条会话', '标题要跟着 journal 走')
})

test('标题 · 没给标题时不会崩，也不会凭空造一个', async () => {
  const { deps } = makeWorld()
  const service = createArchiveService(deps)
  await service.delete(ID_A)
  const row = service.listTrash().rows.find((entry) => entry.id === ID_A)
  assert.ok(row)
  assert.equal(row.title, undefined)
})

test('标题 · 超长标题被截断，不会撑爆 journal', async () => {
  const { deps } = makeWorld()
  const service = createArchiveService(deps)
  await service.delete(ID_A, { title: 'x'.repeat(500) })
  const row = service.listTrash().rows.find((entry) => entry.id === ID_A)
  assert.equal(row.title.length, 120)
})
