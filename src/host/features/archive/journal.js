/**
 * S4-b · the durable delete journal (Pi T5/T6/D4 + the cross-instance lock).
 *
 * Every phase the state machine passes through is written here, whole-file, and
 * atomically: `<dir>/archive-journal.json` is replaced through a temp file and a
 * rename, so a crash can only leave the old complete file or the new one.
 *
 * Two things make it safe between two processes (HMR, two hosts):
 *
 *   - a UNIQUE temp name per process, so two writers never share a temp file;
 *   - an `O_EXCL` lock held across the WHOLE read-modify-write. Locking only the
 *     write is not enough: both instances read the same entries, each adds its
 *     claim, and the second write wins — the first claim disappears, and the GC
 *     can then treat its trash entry as an orphan and delete the user's files.
 *
 * A journal is not a cache. A MISSING file is an empty journal; a file that
 * cannot be parsed is CORRUPT, and `health()` says so, because the GC must stop
 * rather than assume "no entries" (Pi P0-3).
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** An entry's phases, in order. `deleting` is a claim, not a completed step. */
export const PHASES = ['deleting', 'trashed', 'cleaned', 'done']

/** A lock older than this is a crash leftover. */
const LOCK_STALE_MS = 10_000
/** How long a writer waits for the lock before giving up. */
const LOCK_WAIT_MS = 2_000

/** Sleep without spinning the CPU (`Atomics.wait` works on Node's main thread). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Take the cross-instance lock.
 * @param {string} lockPath
 * @returns {boolean} whether the lock was acquired
 */
function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'))
      return true
    } catch (error) {
      if (!(error && error.code === 'EEXIST')) throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath)
          continue
        }
      } catch (statError) {
        continue
      }
      if (Date.now() > deadline) return false
      sleepSync(2)
    }
  }
}

function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath)
  } catch (error) {
    /* already gone */
  }
}

/** Copy entries so neither the caller nor a reader can mutate the store. */
function copy(entries) {
  return entries.map((entry) => ({ ...entry }))
}

/**
 * In-memory journal (tests, and the fallback when no directory is available).
 * @param {object[]} [initial]
 */
export function createMemoryJournal(initial = []) {
  let entries = copy(initial)
  return {
    read() {
      return copy(entries)
    },
    write(next) {
      entries = copy(next)
    },
    update(mutate) {
      const next = mutate(copy(entries))
      if (!Array.isArray(next)) throw new TypeError('journal.update must return an array')
      entries = copy(next)
      return copy(entries)
    },
    health: () => ({ corrupt: false }),
  }
}

/**
 * File-backed journal.
 * @param {string} dir - where `archive-journal.json` lives
 */
export function createFileJournal(dir) {
  const file = join(dir, 'archive-journal.json')
  const lockPath = join(dir, 'archive-journal.lock')
  // P0-8: a unique temp name keeps two instances from overwriting a shared one.
  const temp = join(dir, `archive-journal.json.${process.pid}.tmp`)

  /** Set by read(); a corrupt file must NOT look like an empty one. */
  let corrupt = false

  function read() {
    try {
      const raw = readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed?.entries)) {
        corrupt = true
        return []
      }
      corrupt = false
      return parsed.entries
    } catch (error) {
      // Only a MISSING file is benign. Anything else is a corrupt journal.
      corrupt = !(error && error.code === 'ENOENT')
      return []
    }
  }

  function replace(entries) {
    mkdirSync(dir, { recursive: true })
    const payload = JSON.stringify({ v: 1, at: Date.now(), entries }, null, 2)
    try {
      writeFileSync(temp, payload, 'utf8')
      renameSync(temp, file)
      corrupt = false
    } catch (error) {
      try {
        rmSync(temp, { force: true })
      } catch (cleanupError) {
        /* ignore */
      }
      throw error
    }
  }

  function write(entries) {
    replace(copy(entries))
  }

  /**
   * Read-modify-write under the cross-instance lock. EVERY mutation must go
   * through here; `write(read().map(...))` loses a concurrent claim.
   * @param {(entries: object[]) => object[]} mutate
   */
  function update(mutate) {
    mkdirSync(dir, { recursive: true })
    const held = acquireLock(lockPath)
    try {
      const current = read()
      const next = mutate(copy(current))
      if (!Array.isArray(next)) throw new TypeError('journal.update must return an array')
      replace(next)
      return copy(next)
    } finally {
      if (held) releaseLock(lockPath)
    }
  }

  return {
    read,
    write,
    update,
    /** Ask the FILE, not a stale flag: callers check health before acting. */
    health() {
      read()
      return { corrupt }
    },
    path: file,
    lockPath,
  }
}
