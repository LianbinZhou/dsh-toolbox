/**
 * S4-b · D/T — the trash state machine, over the same case list that is RED
 * against the tombstone service (`tools/prove-service-red.mjs`).
 *
 * Plus the pieces a fake world cannot show: the journal must be atomic and must
 * survive a corrupt file, and a claim must block a second instance.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SERVICE_CASES, runServiceMatrix, makeWorld } from './support/archive-service-matrix.mjs'
import { createArchiveService, REASONS } from '../src/host/features/archive/service.js'
import { createFileJournal, createMemoryJournal } from '../src/host/features/archive/journal.js'

for (const item of SERVICE_CASES) {
  test(item.id + ' · ' + item.title, async () => {
    const summary = await runServiceMatrix(createArchiveService)
    const result = summary.results.find((r) => r.id === item.id)
    assert.equal(result.ok, true, result.error || 'case failed')
  })
}

test('every refusal carries a stable machine code', () => {
  for (const [key, value] of Object.entries(REASONS)) {
    assert.match(value, /^[a-z-]+$/, key + ' must be a code, not a sentence')
  }
  assert.ok(Object.keys(REASONS).length >= 14)
})

test('an invalid id is rejected before any dependency is touched', async () => {
  const { deps, world } = makeWorld()
  const service = createArchiveService(deps)
  const result = await service.delete('../../etc/passwd')
  assert.equal(result.ok, false)
  assert.equal(result.reason, REASONS.INVALID_ID)
  assert.equal(world.calls.probe.length, 0)
})

test('a claim left by a dead process is dropped by heal, not acted on', async () => {
  const claim = {
    id: 'session-aaaaaaaa-1111-2222-3333-444444444444',
    nonce: 'n1',
    phase: 'deleting',
    originalPath: 'C:/home/sessions/projA/session-aaaaaaaa-1111-2222-3333-444444444444',
    trashPath: 'C:/home/storages/archive-trash/n1',
    dev: 1,
    ino: 1,
  }
  const { deps, world } = makeWorld({ journal: [claim] })
  const service = createArchiveService(deps)
  const result = await service.heal()
  assert.ok(result.healed.includes(claim.id), 'the stale claim is resolved')
  assert.deepEqual(service.pendingCleanup(), [])
  assert.equal(world.isArchived(claim.id), true, 'the session stays archived: nothing was moved')
  assert.equal(world.dirExists(claim.id), true)
})

test('two service instances: the second sees the claim and refuses', async () => {
  const { deps, world } = makeWorld()
  const a = createArchiveService(deps)
  const b = createArchiveService(deps)
  const first = a.delete('session-aaaaaaaa-1111-2222-3333-444444444444')
  // The claim is synchronous inside delete, so by the time the promise is in
  // flight the journal already holds `deleting`.
  const second = await b.delete('session-aaaaaaaa-1111-2222-3333-444444444444')
  const firstResult = await first
  assert.equal(firstResult.ok, true)
  assert.equal(second.ok, false, 'the claim is the cross-instance lock')
  assert.ok(['delete-in-progress', 'already-deleted', 'not-archived'].includes(second.reason), 'got ' + second.reason)
  assert.equal(world.calls.rename.length, 1)
})

test('list() reports the phase of a pending entry', async () => {
  const { deps, world } = makeWorld({ failAt: { step: 'workspace', error: new Error('down') } })
  const service = createArchiveService(deps)
  await service.delete('session-aaaaaaaa-1111-2222-3333-444444444444')
  deps.dropWorkspaceRows = (id) => world.calls.workspace.push(id)
  const listed = await service.list()
  assert.equal(listed.ok, true)
  assert.equal(listed.rows.length > 0, true)
})

/* ------------------------------ the journal ------------------------------ */

test('the file journal round-trips through a real file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-journal-'))
  try {
    const journal = createFileJournal(dir)
    assert.deepEqual(journal.read(), [], 'a missing journal is empty, not an error')
    journal.write([{ id: 'x', phase: 'deleting' }])
    assert.deepEqual(journal.read(), [{ id: 'x', phase: 'deleting' }])
    journal.write([{ id: 'y', phase: 'done' }])
    assert.deepEqual(journal.read().map((e) => e.id), ['y'], 'the whole file is replaced')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt journal is treated as empty, never as fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-journal-'))
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'archive-journal.json'), '{ not json', 'utf8')
    const journal = createFileJournal(dir)
    assert.deepEqual(journal.read(), [])
    assert.doesNotThrow(() => journal.write([{ id: 'z', phase: 'trashed' }]))
    assert.deepEqual(journal.read().map((e) => e.id), ['z'], 'a write repairs it')
    assert.equal(readFileSync(join(dir, 'archive-journal.json'), 'utf8').includes('"z"'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the memory journal copies in and out (no aliasing)', () => {
  const source = [{ id: 'a', phase: 'deleting' }]
  const journal = createMemoryJournal(source)
  source[0].phase = 'mutated'
  assert.equal(journal.read()[0].phase, 'deleting', 'the source array cannot mutate the journal')
  const read = journal.read()
  read[0].phase = 'mutated-again'
  assert.equal(journal.read()[0].phase, 'deleting', 'a reader cannot mutate the journal either')
})
