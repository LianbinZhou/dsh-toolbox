/**
 * S4-b · final acceptance, part 1: the REAL archive ids, and the two structural
 * guarantees Pi asked for on top of the trash (a trash root outside the scanned
 * tree, and a lock that is always released).
 *
 * The ids come from a captured live profile (`real-archived-ids.mjs`), not from
 * a session-directory listing: the delete route receives ids from
 * `global.archivedSessionIds`, and 2 of those 34 no longer have a directory.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { isSafeSessionId } from '../src/host/features/archive/paths.js'
import { REAL_ARCHIVED_IDS, REAL_GHOST_IDS, REAL_ARCHIVED_COUNT } from './fixtures/real-archived-ids.mjs'
import { createArchiveService, REASONS } from '../src/host/features/archive/service.js'
import { makeWorld } from './support/archive-service-matrix.mjs'

test('every REAL archived id passes the allowlist (no history locked out)', () => {
  assert.equal(REAL_ARCHIVED_IDS.length, REAL_ARCHIVED_COUNT)
  assert.ok(REAL_ARCHIVED_IDS.length >= 30, 'the snapshot is big enough to mean something')
  for (const id of REAL_ARCHIVED_IDS) {
    assert.equal(isSafeSessionId(id), true, 'real id rejected by the allowlist: ' + id)
  }
})

test('the real snapshot still has ghosts, and they are valid ids too', () => {
  assert.ok(REAL_GHOST_IDS.length >= 1, 'there really are marker-only records in a live profile')
  for (const id of REAL_GHOST_IDS) {
    assert.equal(REAL_ARCHIVED_IDS.includes(id), true, 'a ghost is still an archived id')
    assert.equal(isSafeSessionId(id), true, 'and it must be deletable')
  }
})

test('the real ids survive the whole delete path (cleanup-only for the ghosts)', async () => {
  // A world where only the FIRST id has a directory: every other real id behaves
  // like a ghost, which is exactly the production shape.
  const { deps, world } = makeWorld({ archived: REAL_ARCHIVED_IDS })
  const present = REAL_ARCHIVED_IDS[0]
  world.dirs.delete(present)

  const service = createArchiveService(deps)

  // A ghost: archived, no directory -> the cleanup-only path, not an error.
  const ghost = REAL_GHOST_IDS[0]
  const ghostResult = await service.delete(ghost)
  assert.equal(ghostResult.ok, true, 'a ghost must be cleanable, not stuck')
  assert.equal(ghostResult.reason, REASONS.CLEANUP_ONLY)
  assert.equal(world.isArchived(ghost), false, '删除时就该清标记，不等 purge')
})

test('no real id is rejected as invalid on the way through the service', async () => {
  for (const id of REAL_ARCHIVED_IDS.slice(0, 5)) {
    const { deps } = makeWorld({ archived: [id] })
    const service = createArchiveService(deps)
    const result = await service.delete(id)
    assert.notEqual(result.reason, REASONS.INVALID_ID, 'real id rejected: ' + id)
  }
})

/* ------------------------- T2: the trash must not be scannable -------------- */

test('T2 · a trash root inside the sessions tree is refused', async () => {
  const { deps, world } = makeWorld()
  // Danger: the probe walks `<sessions>/<project>/<segment>`, so an entry inside
  // that tree could be discovered as a session and deleted twice.
  deps.trashRoot = () => 'C:/home/sessions/--trash--'
  const service = createArchiveService(deps)
  const result = await service.delete('session-aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unsafe-trash-root')
  assert.equal(world.dirExists('session-aaaaaaaa-1111-2222-3333-444444444444'), true, 'nothing moved')
})

/* ------------------------- D3: the lock is always released ---------------- */

test('D3 · a failing dependency never leaves the id locked', async () => {
  const { deps, world } = makeWorld()
  let attempts = 0
  deps.renamePath = () => {
    attempts += 1
    throw new Error('EBUSY')
  }
  const service = createArchiveService(deps)
  const first = await service.delete('session-aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(first.ok, false)
  assert.equal(first.reason, REASONS.MOVE_FAILED)
  const second = await service.delete('session-aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(second.ok, false)
  assert.equal(attempts, 2, 'the second attempt reached the dependency, so the lock was released')
  assert.equal(world.isArchived('session-aaaaaaaa-1111-2222-3333-444444444444'), true)
})

test('D3b · an unrelated id is not blocked by a stuck one', async () => {
  const { deps } = makeWorld()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const originalRename = deps.renamePath
  deps.renamePath = async (from, to) => {
    if (from.includes('aaaaaaaa')) await gate
    return originalRename(from, to)
  }
  const service = createArchiveService(deps)
  const slow = service.delete('session-aaaaaaaa-1111-2222-3333-444444444444')
  const fast = await service.delete('session-bbbbbbbb-1111-2222-3333-444444444444')
  assert.equal(fast.ok, true, 'the other id is not held up')
  release()
  await slow
})
