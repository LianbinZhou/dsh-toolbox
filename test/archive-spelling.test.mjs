/**
 * journal 里存的拼写和请求的不一样时，finish 也必须能找到记录并收尾。
 *
 * 这是「删除后停在 trashed、lastError 为空」的真实嫌疑：
 * findEntry 精确比较找不到，finish 直接返回 ok，phase 永远停在 trashed。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createArchiveService } from '../src/host/features/archive/service.js'
import { makeWorld, ID_A } from './support/archive-service-matrix.mjs'

const BARE = ID_A.replace(/^session-/, '')

test('拼写 · journal 存裸 id、请求带 session- 前缀，删除仍能收尾到 cleaned', async () => {
  const { deps, world } = makeWorld()
  const service = createArchiveService(deps)
  world.archived.add(BARE)
  world.archived.add(ID_A)

  const removed = await service.delete(ID_A)
  assert.equal(removed.ok, true)
  assert.equal(world.journalEntries()[0].phase, 'cleaned', '不能停在 trashed')
})

test('拼写 · journal 存 session- 前缀、请求裸 id，同样能收尾', async () => {
  const { deps, world } = makeWorld()
  const service = createArchiveService(deps)
  world.archived.add(BARE)
  world.archived.add(ID_A)

  const removed = await service.delete(BARE)
  assert.equal(removed.ok, true)
  assert.equal(world.journalEntries()[0].phase, 'cleaned')
})

test('拼写 · 收尾后归档集合里两种拼写都被清掉', async () => {
  const { deps, world } = makeWorld()
  const service = createArchiveService(deps)
  world.archived.add(BARE)
  world.archived.add(ID_A)

  await service.delete(ID_A)
  const left = [...world.archived].filter((value) => value === ID_A || value === BARE)
  // 删除保留标记（purge/restore 才清）：清掉会让会话以「未分组」回到侧栏。
  assert.deepEqual(left, [], '两种拼写都必须清掉')
})
