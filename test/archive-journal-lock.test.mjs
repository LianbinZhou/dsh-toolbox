/**
 * S4-b · the cross-instance journal lock (Pi P0).
 *
 * The dangerous failure is not a corrupt file (renames are atomic) but a LOST
 * UPDATE: two instances read the same entries, each appends its own claim, and
 * whichever writes last erases the other's claim. The erased claim's trash entry
 * then looks like an orphan to the GC, which deletes the user's only copy.
 *
 * That cannot be reproduced inside one process, so this test spawns TWO REAL
 * node processes writing to the same journal directory at the same time.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createFileJournal } from '../src/host/features/archive/journal.js'

const JOURNAL_URL = pathToFileURL(join(import.meta.dirname ?? '', '../src/host/features/archive/journal.js')).href
const WRITERS = 2
const PER_WRITER = 40

/** The script each child runs: append PER_WRITER entries through update(). */
function childScript(dir, tag) {
  return `
import { createFileJournal } from ${JSON.stringify(JOURNAL_URL)}
const journal = createFileJournal(${JSON.stringify(dir)})
for (let i = 0; i < ${PER_WRITER}; i += 1) {
  journal.update((entries) => [...entries, { id: '${tag}-' + i, phase: 'deleting' }])
}
`
}

function runChild(dir, tag) {
  return new Promise((resolve, reject) => {
    // `node --test` exports NODE_TEST_CONTEXT (and friends) to its workers. A
    // child that inherits them behaves like a test worker instead of a plain
    // program, which made this test fail only inside the full suite.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST')))
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript(dir, tag)], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env,
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error('child ' + tag + ' exited ' + code + ': ' + stderr))
    })
  })
}

test('P0 · two processes writing the same journal lose no entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-lock-'))
  try {
    await Promise.all(Array.from({ length: WRITERS }, (_, index) => runChild(dir, 'w' + index)))

    const journal = createFileJournal(dir)
    const entries = journal.read()
    assert.equal(entries.length, WRITERS * PER_WRITER, 'every claim must survive: got ' + entries.length)

    // Both writers are represented, so neither overwrote the other.
    for (let index = 0; index < WRITERS; index += 1) {
      const mine = entries.filter((entry) => String(entry.id).startsWith('w' + index + '-'))
      assert.equal(mine.length, PER_WRITER, 'writer ' + index + ' kept its ' + PER_WRITER + ' entries')
    }

    const ids = new Set(entries.map((entry) => entry.id))
    assert.equal(ids.size, entries.length, 'no duplicate ids')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P0 · a stale lock left by a crash does not block the next writer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-lock-stale-'))
  try {
    const journal = createFileJournal(dir)
    // A lock file older than the stale window is a crash leftover.
    const { writeFileSync, utimesSync } = await import('node:fs')
    writeFileSync(journal.lockPath, '')
    const old = (Date.now() - 60_000) / 1000
    utimesSync(journal.lockPath, old, old)

    const next = journal.update((entries) => [...entries, { id: 'after-stale', phase: 'deleting' }])
    assert.equal(next.length, 1, 'the writer recovered from a stale lock')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P0 · update() runs the mutator once per call and returns the new entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-lock-single-'))
  try {
    const journal = createFileJournal(dir)
    let runs = 0
    const first = journal.update((entries) => {
      runs += 1
      return [...entries, { id: 'a', phase: 'deleting' }]
    })
    const second = journal.update((entries) => [...entries, { id: 'b', phase: 'deleting' }])
    assert.equal(runs, 1)
    assert.equal(first.length, 1)
    assert.equal(second.length, 2)
    assert.equal(journal.read().length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
