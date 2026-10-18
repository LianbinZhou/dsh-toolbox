/**
 * 4.2 双路径边界：末段对、前缀对，都可能还在根外。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createArchiveService } from '../src/host/features/archive/service.js'
import { makeWorld, ID_A } from './support/archive-service-matrix.mjs'

const TRASH = 'C:/home/storages/archive-trash'

function entry(overrides = {}) {
  return {
    id: ID_A,
    nonce: 'n1',
    phase: 'cleaned',
    originalPath: 'C:/home/sessions/projA/' + ID_A,
    trashPath: TRASH + '/n1',
    dev: 1,
    ino: 1,
    at: 1,
    ...overrides,
  }
}

test('4.2 · 根外绝对路径（末段仍是 id）必须拒绝', async () => {
  const { deps, world } = makeWorld({ journal: [entry({ originalPath: 'C:/outside/' + ID_A })] })
  const service = createArchiveService(deps)
  const result = await service.restore(ID_A)
  assert.equal(result.ok, false, 'C:/outside 不在会话根里，必须拒绝')
  assert.equal(result.reason, 'journal-corrupt')
  assert.equal(world.calls.rename.length, 0)
})

test('4.2 · trashPath 用 ../ 穿出根外必须拒绝', async () => {
  const { deps, world } = makeWorld({ journal: [entry({ trashPath: TRASH + '/../outside/n1' })] })
  const service = createArchiveService(deps)
  const result = await service.restore(ID_A)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'journal-corrupt')
  assert.equal(world.calls.rename.length, 0)
})

test('4.2 · 合法路径继续通过', async () => {
  const { deps, world } = makeWorld({ journal: [entry()] })
  world.trash.set(TRASH + '/n1', ID_A)
  world.dirs.set(ID_A, 'C:/home/sessions/projA/' + ID_A)
  const service = createArchiveService(deps)
  const result = await service.restore(ID_A)
  assert.equal(result.ok, true, '正常路径不能被误伤')
})
