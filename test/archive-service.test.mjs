/**
 * S4-b · R4/R5 — the state machine, over the same case list that is red against
 * the pre-migration algorithm.
 *
 * `tools/prove-service-red.mjs` runs the identical list against the legacy
 * fixture, so a green here means something.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { SERVICE_CASES, runServiceMatrix } from './support/archive-service-matrix.mjs'
import { createArchiveService, REASONS } from '../src/host/features/archive/service.js'

for (const item of SERVICE_CASES) {
  test(item.id + ' · ' + item.title, async () => {
    const summary = await runServiceMatrix(createArchiveService)
    const result = summary.results.find((r) => r.id === item.id)
    assert.equal(result.ok, true, result.error || 'case failed')
  })
}

test('every refusal carries a stable machine code', () => {
  assert.ok(Object.keys(REASONS).length >= 8)
  for (const [key, value] of Object.entries(REASONS)) {
    assert.equal(typeof value, 'string', key)
    assert.match(value, /^[a-z-]+$/, key + ' is a code, not a sentence')
  }
})

test('an invalid id is rejected before the lock or any dependency', async () => {
  let touched = 0
  const service = createArchiveService({
    readArchived: () => {
      touched += 1
      return []
    },
    isLive: () => false,
    findDir: () => undefined,
    removeDir: () => {},
    unarchive: () => {},
    dropWorkspaceRows: () => {},
    scrubCache: () => {},
  })
  const result = await service.delete('../../etc/passwd')
  assert.equal(result.ok, false)
  assert.equal(result.status, 400)
  assert.equal(result.reason, REASONS.INVALID_ID)
  assert.equal(touched, 0, 'a malformed id must not even read the archive')
})

test('independent ids do not block each other', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const archived = new Set([
    'session-aaaaaaaa-1111-2222-3333-444444444444',
    'session-bbbbbbbb-1111-2222-3333-444444444444',
  ])
  const service = createArchiveService({
    readArchived: () => [...archived],
    isLive: () => false,
    findDir: (id) => '/sessions/p/' + id,
    removeDir: () => {},
    unarchive: (id) => archived.delete(id),
    dropWorkspaceRows: () => {},
    scrubCache: () => {},
    beforeStep: async (step, id) => {
      if (id.startsWith('session-aaaaaaaa')) await gate
    },
  })

  const slow = service.delete('session-aaaaaaaa-1111-2222-3333-444444444444')
  const fast = await service.delete('session-bbbbbbbb-1111-2222-3333-444444444444')
  assert.equal(fast.ok, true, 'the unrelated id is not held up by the paused one')
  release()
  assert.equal((await slow).ok, true)
})

test('the lock is released when a dependency throws', async () => {
  const archived = new Set(['session-aaaaaaaa-1111-2222-3333-444444444444'])
  let attempts = 0
  const service = createArchiveService({
    readArchived: () => [...archived],
    isLive: () => false,
    findDir: () => '/sessions/p/session-aaaaaaaa-1111-2222-3333-444444444444',
    removeDir: () => {
      attempts += 1
      throw new Error('EBUSY')
    },
    unarchive: (id) => archived.delete(id),
    dropWorkspaceRows: () => {},
    scrubCache: () => {},
  })

  const first = await service.delete('session-aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(first.ok, false)
  assert.equal(first.reason, REASONS.REMOVE_FAILED)
  assert.equal(archived.has('session-aaaaaaaa-1111-2222-3333-444444444444'), true, 'the marker survives a failed removal')

  const second = await service.delete('session-aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(second.ok, false, 'still failing')
  assert.equal(attempts, 2, 'the second attempt was not blocked by a stuck lock')
})

test('heal() is idempotent and survives being called with nothing pending', () => {
  const service = createArchiveService({
    readArchived: () => [],
    isLive: () => false,
    findDir: () => undefined,
    removeDir: () => {},
    unarchive: () => {},
    dropWorkspaceRows: () => {},
    scrubCache: () => {},
  })
  assert.deepEqual(service.heal(), { ok: true, healed: [], pending: [] })
  assert.deepEqual(service.heal(), { ok: true, healed: [], pending: [] })
  assert.deepEqual(service.pendingCleanup(), [])
})
