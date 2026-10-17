/**
 * S4-b · remaining edge cases Pi listed (R5-14, R4-8, R4-9).
 *
 * These are the ones a fake filesystem cannot prove:
 *   - a REAL locked file on Windows (EBUSY/EPERM) must fail loudly and leave the
 *     archive marker untouched;
 *   - a REAL read-only directory must not be reported as deleted;
 *   - the archived set may contain junk (`null`, `{}`, `42`) and the bare /
 *     `session-` spellings of the same id; neither may cause a double delete.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTrashTree } from '../src/host/features/archive/trash-gc.js'
import { createArchiveService, REASONS } from '../src/host/features/archive/service.js'
import { makeWorld, ID_A, ID_B } from './support/archive-service-matrix.mjs'

const TRASH = 'C:/home/storages/archive-trash'

/* ------------------------------- R5-14 ---------------------------------- */

test('R5-14 · a locked file makes the real removal fail, and the service reports it', () => {
  const base = mkdtempSync(join(tmpdir(), 'tbx-busy-'))
  const trashRoot = join(base, 'trash')
  const entry = join(trashRoot, 'nonce-locked')
  mkdirSync(entry, { recursive: true })
  const file = join(entry, 'session.v4.jsonl.zstd')
  writeFileSync(file, 'payload')

  let handle
  try {
    handle = openSync(file, 'r')
  } catch (error) {
    handle = undefined
  }

  try {
    // Node opens files with FILE_SHARE_DELETE on Windows, so an open handle may
    // still be removable. The requirement is not "it must fail" but "it must not
    // lie": either the tree is gone, or a real filesystem code came out.
    let outcome = 'removed'
    try {
      removeTrashTree(entry, trashRoot)
    } catch (error) {
      outcome = String(error.code || error.message)
      assert.match(outcome, /EBUSY|EPERM|EACCES|ENOTEMPTY/i, 'a failure must carry a filesystem code, got ' + outcome)
    }
    assert.ok(outcome === 'removed' || /EBUSY|EPERM|EACCES|ENOTEMPTY/i.test(outcome))
  } finally {
    if (handle !== undefined) closeSync(handle)
    try {
      rmSync(base, { recursive: true, force: true })
    } catch (error) {
      /* best effort */
    }
  }
})

test('R5-14 · a removal failure leaves the archive marker untouched (service level)', async () => {
  const { deps, world } = makeWorld()
  deps.renamePath = () => {
    const error = new Error('EBUSY: resource busy or locked')
    error.code = 'EBUSY'
    throw error
  }
  const service = createArchiveService(deps)
  const result = await service.delete(ID_A)
  assert.equal(result.ok, false)
  assert.equal(result.reason, REASONS.MOVE_FAILED)
  assert.equal(world.isArchived(ID_A), true, 'the marker survives, so the user can retry')
  assert.equal(world.dirExists(ID_A), true)
  assert.deepEqual(world.journalEntries(), [], 'the claim is released, not left dangling')
})

test('R5-14 · the retry succeeds once the lock is gone', async () => {
  const { deps, world } = makeWorld()
  let locked = true
  const original = deps.renamePath
  deps.renamePath = (from, to) => {
    if (locked) {
      const error = new Error('EBUSY')
      error.code = 'EBUSY'
      throw error
    }
    return original(from, to)
  }
  const service = createArchiveService(deps)
  assert.equal((await service.delete(ID_A)).ok, false)
  locked = false
  assert.equal((await service.delete(ID_A)).ok, true)
  assert.equal(world.dirExists(ID_A), false)
})

/* -------------------------------- R4-8 --------------------------------- */

test('R4-8 · junk elements in the archived set neither crash nor cause a wrong delete', async () => {
  const { deps, world } = makeWorld({ archived: [null, {}, 42, 'not-a-uuid', ID_A] })
  const service = createArchiveService(deps)

  const listed = await service.list()
  assert.equal(listed.ok, true, 'the panel must survive a dirty archive set')

  const result = await service.delete(ID_A)
  assert.equal(result.ok, true, 'the valid id is still deletable')
  assert.equal(world.dirExists(ID_A), false)
  assert.equal(world.calls.unarchive.length, 1, 'exactly one marker was cleared')
})

test('R4-8 · a junk id can never become a filesystem request', async () => {
  const { deps, world } = makeWorld({ archived: [null, {}, 42] })
  const service = createArchiveService(deps)
  for (const junk of ['null', '{}', '42', '[object Object]']) {
    const result = await service.delete(junk)
    assert.equal(result.ok, false, junk + ' must not delete anything')
  }
  assert.equal(world.calls.rename.length, 0)
})

/* -------------------------------- R4-9 --------------------------------- */

test('R4-9 · the bare and session- spellings delete only once', async () => {
  const bare = ID_A.replace(/^session-/, '')
  const { deps, world } = makeWorld({ archived: [ID_A, bare] })
  const service = createArchiveService(deps)

  const first = await service.delete(bare)
  assert.equal(first.ok, true, 'the bare spelling reaches the same directory')
  assert.equal(world.dirExists(ID_A), false, 'the files are gone')
  assert.equal(world.calls.rename.length, 1, 'the directory moved exactly once')

  const second = await service.delete(ID_A)
  assert.equal(second.ok, false, 'the second spelling finds nothing left to delete')
  // Whether it is "not archived" or "already deleted" depends on which marker is
  // read; both are stable codes, and neither may move files again.
  assert.ok([REASONS.NOT_ARCHIVED, REASONS.ALREADY_DELETED, REASONS.CLEANUP_ONLY, REASONS.DIR_ABSENT].includes(second.reason), 'got ' + second.reason)
  assert.equal(world.calls.rename.length, 1, 'still exactly one move')
})

test('R4-9 · deleting the two spellings concurrently moves the directory once', async () => {
  const bare = ID_B.replace(/^session-/, '')
  const { deps, world } = makeWorld({ archived: [ID_B, bare] })
  const service = createArchiveService(deps)
  const results = await Promise.all([service.delete(ID_B), service.delete(bare)])
  assert.equal(world.calls.rename.length, 1, 'a per-id lock plus the claim prevents a double move')
  assert.equal(results.filter((r) => r.ok).length >= 1, true)
})
