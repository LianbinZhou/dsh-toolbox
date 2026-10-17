/**
 * S4-b · T9 (garbage collection) and T10 (no nested junction escapes).
 *
 * T9: a trash that only grows is a second disk-full bug. Finished entries go at
 * once; orphaned ones wait out a TTL; a full trash evicts the oldest unprotected
 * entry. An entry that is still restorable is NEVER evicted by pressure.
 *
 * T10: removing a trash entry must unlink links instead of following them, and
 * the path itself must still resolve inside the trash root. Real temp trees and
 * real Windows junctions.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTrashGc, removeTrashTree } from '../src/host/features/archive/trash-gc.js'
import { createMemoryJournal } from '../src/host/features/archive/journal.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

function gcFor(entries, journalEntries, options = {}) {
  const removed = []
  const journal = createMemoryJournal(journalEntries)
  const gc = createTrashGc({
    listTrash: () => entries,
    journal,
    remove: (path) => removed.push(path),
    now: () => NOW,
    ...options,
  })
  return { gc, removed }
}

test('T9 · a finished entry is purged immediately', () => {
  const { gc, removed } = gcFor(
    [{ path: '/t/done', at: NOW }],
    [{ id: 'a', trashPath: '/t/done', phase: 'done' }],
  )
  const result = gc.run()
  assert.deepEqual(removed, ['/t/done'])
  assert.deepEqual(result.purged, ['/t/done'])
})

test('T9 · a restorable entry is never evicted by age or pressure', () => {
  const { gc, removed } = gcFor(
    [{ path: '/t/old', at: NOW - 30 * DAY }],
    [{ id: 'a', trashPath: '/t/old', phase: 'trashed' }],
    { ttlMs: DAY, maxEntries: 0 },
  )
  const result = gc.run()
  assert.deepEqual(removed, [], 'the only copy of the user files must survive')
  assert.equal(result.protected, 1)
})

test('T9 · orphans are purged after the TTL, and kept before it', () => {
  const entries = [
    { path: '/t/ancient', at: NOW - 10 * DAY },
    { path: '/t/fresh', at: NOW - 1 * 1000 },
  ]
  const { gc, removed } = gcFor(entries, [], { ttlMs: 7 * DAY })
  gc.run()
  assert.deepEqual(removed, ['/t/ancient'])
})

test('T9 · capacity evicts the oldest unprotected entry first', () => {
  const entries = [
    { path: '/t/new', at: NOW - 1 * DAY },
    { path: '/t/old', at: NOW - 3 * DAY },
    { path: '/t/mid', at: NOW - 2 * DAY },
  ]
  const { gc, removed } = gcFor(entries, [], { ttlMs: 365 * DAY, maxEntries: 2 })
  const result = gc.run()
  assert.deepEqual(removed, ['/t/old'], 'the oldest goes first')
  assert.equal(result.kept, 2)
})

/* --------------------------------- T10 --------------------------------- */

function makeTrash() {
  const base = mkdtempSync(join(tmpdir(), 'tbx-gc-'))
  const trashRoot = join(base, 'archive-trash')
  const entry = join(trashRoot, 'nonce-1')
  mkdirSync(entry, { recursive: true })
  writeFileSync(join(entry, 'session.v4.jsonl.zstd'), 'payload')
  const outside = join(base, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'marker.json'), '{"survive":true}')
  return { base, trashRoot, entry, outside }
}

test('T10 · a nested junction inside a trash entry is unlinked, not followed', () => {
  const world = makeTrash()
  try {
    let linked = true
    try {
      symlinkSync(world.outside, join(world.entry, 'nested-link'), 'junction')
    } catch (error) {
      linked = false
    }
    removeTrashTree(world.entry, world.trashRoot)
    assert.equal(existsSync(world.entry), false, 'the entry is gone')
    if (linked) {
      assert.equal(existsSync(join(world.outside, 'marker.json')), true, 'the junction target must survive')
    }
  } finally {
    try {
      rmSync(world.base, { recursive: true, force: true })
    } catch (error) {
      /* best effort */
    }
  }
})

test('T10 · the trash root itself is never removable', () => {
  const world = makeTrash()
  try {
    assert.throws(() => removeTrashTree(world.trashRoot, world.trashRoot), /refus/i)
    assert.equal(existsSync(world.trashRoot), true)
  } finally {
    try {
      rmSync(world.base, { recursive: true, force: true })
    } catch (error) {
      /* best effort */
    }
  }
})

test('T10 · a path outside the trash root is refused', () => {
  const world = makeTrash()
  try {
    assert.throws(() => removeTrashTree(world.outside, world.trashRoot), /refus/i)
    assert.equal(existsSync(join(world.outside, 'marker.json')), true)
  } finally {
    try {
      rmSync(world.base, { recursive: true, force: true })
    } catch (error) {
      /* best effort */
    }
  }
})

test('T10 · a real entry with files and nested directories is fully removed', () => {
  const world = makeTrash()
  try {
    const nested = join(world.entry, 'deep', 'deeper')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'file.txt'), 'x')
    removeTrashTree(world.entry, world.trashRoot)
    assert.equal(existsSync(world.entry), false)
    assert.deepEqual(readdirSync(world.trashRoot), [], 'the trash root stays, empty')
  } finally {
    try {
      rmSync(world.base, { recursive: true, force: true })
    } catch (error) {
      /* best effort */
    }
  }
})
