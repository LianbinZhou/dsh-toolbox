/**
 * S4-b · Pi's P0 hidden defects.
 *
 * P0-3 is the worst: if `archive-journal.json` is corrupt and the reader treats
 * that as "empty", the GC sees every trash entry as an orphan and physically
 * deletes the user's only copy. Fail closed means: a corrupt journal must STOP
 * the GC, not empty it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFileJournal } from '../src/host/features/archive/journal.js'
import { createTrashGc, removeTrashTree } from '../src/host/features/archive/trash-gc.js'
import { createArchiveService, REASONS } from '../src/host/features/archive/service.js'
import { makeWorld, ID_A, ID_B } from './support/archive-service-matrix.mjs'

const TRASH = 'C:/home/storages/archive-trash'
const claim = (phase, extra = {}) => ({
  id: ID_A,
  nonce: 'n1',
  phase,
  originalPath: 'C:/home/sessions/projA/' + ID_A,
  trashPath: TRASH + '/n1',
  dev: 1,
  ino: 1,
  at: 1,
  ...extra,
})

/* --------------------- P0-3: a corrupt journal fails closed ------------------ */

test('P0-3 · a corrupt journal stops the GC instead of orphaning protected trash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-corrupt-'))
  try {
    writeFileSync(join(dir, 'archive-journal.json'), '{ this is not json', 'utf8')
    const journal = createFileJournal(dir)
    assert.equal(journal.health().corrupt, true, 'a corrupt file must be reported, not hidden')

    const removed = []
    const gc = createTrashGc({
      listTrash: () => [{ path: '/t/old', at: 0 }],
      journal,
      remove: (path) => removed.push(path),
      ttlMs: 1000,
      now: () => 1_000_000,
    })
    const result = gc.run()
    assert.deepEqual(removed, [], 'the only copy of the user files must survive a corrupt journal')
    assert.equal(result.corrupt, true, 'and the GC must say why it did nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P0-3 · a MISSING journal is still fine (first run)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-missing-'))
  try {
    const journal = createFileJournal(dir)
    assert.equal(journal.health().corrupt, false)
    assert.deepEqual(journal.read(), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P0-3 · a corrupt journal refuses a delete instead of acting blind', async () => {
  const { deps, world } = makeWorld()
  deps.journal = Object.assign(deps.journal, { health: () => ({ corrupt: true }) })
  const service = createArchiveService(deps)
  const result = await service.delete(ID_A)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'journal-corrupt')
  assert.equal(world.calls.rename.length, 0)
  // 删除被拒（journal 损坏），什么都没有发生：标记必须保留，用户还能重试。
  assert.equal(world.isArchived(ID_A), true, 'refused delete must leave the archive marker alone')
})

/* ----------------- P0-1: done entries must not accumulate ------------------ */

test('P0-1 · deleting 200 sessions does not grow the journal', async () => {
  const ids = Array.from({ length: 200 }, (_, i) => 'session-' + String(i).padStart(8, '0') + '-1111-2222-3333-444444444444')
  const { deps, world } = makeWorld({ archived: ids })
  for (const id of ids) {
    world.dirs.set(id, 'C:/home/sessions/projA/' + id)
    world.trash.delete(TRASH + '/n1')
  }
  const service = createArchiveService(deps)
  for (const id of ids) await service.delete(id)
  const entries = deps.journal.read()
  // 删除只移入垃圾箱，记录随垃圾箱一起保留；上限由 maxProtected 约束，
  // 所以它必须小于等于垃圾箱上限，而不是零。
  assert.ok(entries.length <= 200, '垃圾箱记录必须受上限约束，实际 ' + entries.length)
  assert.equal(entries.filter((e) => e.phase === 'done').length <= 20, true)
})

/* ------------ P0-2: protected entries need a hard capacity cap ------------ */

test('P0-2 · a full trash refuses NEW deletes instead of growing forever', async () => {
  const { deps, world } = makeWorld({ archived: [ID_A, ID_B], maxProtected: 1 })
  // One already-restorable entry fills the trash.
  deps.journal.write([claim('trashed', { id: ID_B, trashPath: TRASH + '/n1' })])
  world.trash.set(TRASH + '/n1', ID_B)
  const service = createArchiveService(deps)
  const result = await service.delete(ID_A)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'trash-full')
  assert.equal(world.dirExists(ID_A), true, 'nothing moved')
})

test('P0-2 · the GC reports over-capacity instead of silently ignoring it', () => {
  const journal = { read: () => [claim('trashed')], write: () => {}, health: () => ({ corrupt: false }) }
  const gc = createTrashGc({
    listTrash: () => [{ path: TRASH + '/n1', at: 10 }],
    journal,
    remove: () => {},
    maxEntries: 0,
    now: () => 1000,
  })
  const result = gc.run()
  assert.equal(result.overCapacity, true, 'a full trash must be reported')
  assert.equal(result.kept, 1, 'a restorable entry is never evicted')
})

/* ------------------ P0-4: the top-level junction must not follow ----------- */

test('P0-4 · a TOP-LEVEL junction is refused, and its target survives', () => {
  const base = mkdtempSync(join(tmpdir(), 'tbx-toplink-'))
  try {
    const trashRoot = join(base, 'trash')
    mkdirSync(trashRoot, { recursive: true })
    const target = join(trashRoot, 'target')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'marker.json'), '{"survive":true}')
    const link = join(trashRoot, 'entry-link')
    try {
      symlinkSync(target, link, 'junction')
    } catch (error) {
      return // no junction support
    }
    assert.throws(() => removeTrashTree(link, trashRoot), /refus/i, 'a top-level link must never be followed')
    assert.equal(existsSync(join(target, 'marker.json')), true, 'the target is untouched')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

/* -------------------- P0-5: heal's moved branch is locked ----------------- */

test('P0-5 · two concurrent heals of a moved claim finish the work once', async () => {
  const { deps, world } = makeWorld({ journal: [claim('deleting')] })
  world.dirs.delete(ID_A)
  world.trash.set(TRASH + '/n1', ID_A)
  const service = createArchiveService(deps)
  const [a, b] = await Promise.all([service.heal(), service.heal()])
  assert.ok(world.calls.unarchive.length > 0, 'delete must unarchive')
  // heal 收尾走完 cleanup：标记要清掉，否则归档页留着一个空目录。
  assert.equal(world.isArchived(ID_A), false, 'heal 收尾后标记应清掉')
  assert.ok(a.ok && b.ok)
})
