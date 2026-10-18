/**
 * 第四刀：journal 被篡改时，恢复必须拒绝。
 *
 * 篡改场景：有人（或某个 bug）把 originalPath 改成 ../../outside，
 * 或者改成别的路径。如果照单全收，恢复就会把文件写到垃圾箱根之外。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createArchiveService } from '../src/host/features/archive/service.js'
import { makeWorld, ID_A } from './support/archive-service-matrix.mjs'

const TRASH = 'C:/home/storages/archive-trash'

function tampered(originalPath) {
  return {
    id: ID_A,
    nonce: 'n1',
    phase: 'cleaned',
    originalPath,
    trashPath: TRASH + '/n1',
    dev: 1,
    ino: 1,
    at: 1,
  }
}

test('tamper · originalPath 含 .. 时拒绝恢复，且不移动任何文件', async () => {
  const { deps, world } = makeWorld({ journal: [tampered('C:/home/sessions/../../outside/' + ID_A)] })
  const service = createArchiveService(deps)
  const result = await service.restore(ID_A)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'journal-corrupt')
  assert.equal(world.calls.rename.length, 0, '绝不能执行移动')
})

test('tamper · originalPath 末段不是这个会话 id 时拒绝', async () => {
  const { deps, world } = makeWorld({ journal: [tampered('C:/home/outside/evil-name')] })
  const service = createArchiveService(deps)
  const result = await service.restore(ID_A)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'journal-corrupt')
  assert.equal(world.calls.rename.length, 0)
})

test('tamper · trashPath 不在垃圾箱根内时拒绝', async () => {
  const entry = tampered('C:/home/sessions/projA/' + ID_A)
  entry.trashPath = 'C:/somewhere/else/n1'
  const { deps, world } = makeWorld({ journal: [entry] })
  const service = createArchiveService(deps)
  const result = await service.restore(ID_A)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'journal-corrupt')
  assert.equal(world.calls.rename.length, 0)
})
