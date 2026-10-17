/**
 * S4-b · the FOUR crash points Pi named.
 *
 * Each test builds the exact on-disk state a crash would leave behind, then
 * constructs a BRAND NEW service over the same journal and asserts what the
 * restart must do. No mocks of the crash itself: the journal and the trash are
 * the only state that survives.
 *
 *   1. claim written, rename not run        -> drop the claim, session untouched
 *   2. rename run, journal still `deleting` -> adopt the trash entry and finish
 *   3. journal `trashed`, unarchive not run -> cleanup completes
 *   4. journal `cleaned`, purge not run     -> purge completes, no ghost
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { makeWorld, ID_A, ID_B, TRASH } from './support/archive-service-matrix.mjs'
import { createArchiveService } from '../src/host/features/archive/service.js'

/** The journal entry a crash at each point would have left. */
function claim(phase, extra = {}) {
  return {
    id: ID_A,
    nonce: 'crash-nonce',
    phase,
    originalPath: 'C:/home/sessions/projA/' + ID_A,
    trashPath: TRASH + '/crash-nonce',
    dev: 1,
    ino: 1000,
    at: 1,
    ...extra,
  }
}

test('crash 1 · claim written, nothing moved yet: the claim is dropped', async () => {
  const { deps, world } = makeWorld({ journal: [claim('deleting')] })
  const service = createArchiveService(deps) // a fresh instance == a restart
  const result = await service.heal()

  assert.deepEqual(result.pending, [], 'nothing is left pending')
  assert.deepEqual(service.pendingCleanup(), [], 'the claim is gone from the journal')
  assert.equal(world.dirExists(ID_A), true, 'the session directory is untouched')
  assert.equal(world.isArchived(ID_A), true, 'and it stays archived, so the user can retry')
  assert.equal(world.calls.rename.length, 0, 'the restart does not move anything')
})

test('crash 2 · the directory moved but the journal was not updated: adopt and finish', async () => {
  const { deps, world } = makeWorld({ journal: [claim('deleting')] })
  // The rename DID happen: the session is gone from sessions/, the trash holds it.
  world.dirs.delete(ID_A)
  world.trash.set(TRASH + '/crash-nonce', ID_A)

  const service = createArchiveService(deps)
  const result = await service.heal()

  assert.deepEqual(result.pending, [], 'the restart finishes the job')
  assert.deepEqual(service.pendingCleanup(), [], 'no entry is left behind')
  assert.equal(world.trashCount(), 1, '删除只移入垃圾箱：保留期没到之前不许物理清空')
  assert.equal(world.isArchived(ID_A), false, 'the archive marker is cleared')
  assert.equal(world.calls.unarchive.length, 1, 'the bookkeeping ran exactly once')
})

test('crash 3 · trashed, unarchive not run: the restart finishes the bookkeeping', async () => {
  const { deps, world } = makeWorld({ journal: [claim('trashed')] })
  world.dirs.delete(ID_A)
  world.trash.set(TRASH + '/crash-nonce', ID_A)

  const service = createArchiveService(deps)
  await service.heal()

  assert.equal(world.isArchived(ID_A), false, 'the marker is cleared by the restart')
  assert.equal(world.trashCount(), 1, '仍在垃圾箱里等保留期')
  assert.deepEqual(service.pendingCleanup(), [])
})

test('crash 4 · cleaned, purge not run: the restart only purges, no ghost', async () => {
  const { deps, world } = makeWorld({ journal: [claim('cleaned')], archived: [ID_B] })
  world.dirs.delete(ID_A)
  world.trash.set(TRASH + '/crash-nonce', ID_A)

  const service = createArchiveService(deps)
  await service.heal()

  assert.equal(world.trashCount(), 1, '仍在垃圾箱里等保留期')
  assert.deepEqual(service.pendingCleanup(), [], 'nothing pending')
  assert.equal(world.isArchived(ID_B), true, 'an unrelated session is untouched')
  assert.equal(world.dirExists(ID_B), true)
})

test('all four crash states are recoverable through list() as well', async () => {
  for (const phase of ['deleting', 'trashed', 'cleaned']) {
    const { deps, world } = makeWorld({ journal: [claim(phase)] })
    if (phase === 'trashed' || phase === 'cleaned') {
      world.dirs.delete(ID_A)
      world.trash.set(TRASH + '/crash-nonce', ID_A)
    }
    const service = createArchiveService(deps)
    const listed = await service.list()
    assert.equal(listed.ok, true, phase + ': list must not throw')
    assert.deepEqual(service.pendingCleanup(), [], phase + ': list heals the journal')
  }
})
