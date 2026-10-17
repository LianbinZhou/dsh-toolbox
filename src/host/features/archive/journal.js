/**
 * S4-b · the durable delete journal (Pi's T5/T6/D4).
 *
 * Every phase the state machine passes through is written here, whole-file,
 * atomically: `<dir>/archive-journal.json` is replaced through a temp file and a
 * rename, so a crash can only leave the old complete file or the new complete
 * file — never a half-written one.
 *
 * A journal is not a cache: it is the only memory that survives a restart, so the
 * service can resume "the files are in the trash but the marker is still there".
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** An entry's phases, in order. `deleting` is a claim, not a completed step. */
export const PHASES = ['deleting', 'trashed', 'cleaned', 'done']

/**
 * In-memory journal (tests, and a safe fallback when no directory is available).
 */
export function createMemoryJournal(initial = []) {
  let entries = initial.map((entry) => ({ ...entry }))
  return {
    health: () => ({ corrupt: false }),
    read() {
      return entries.map((entry) => ({ ...entry }))
    },
    write(next) {
      entries = next.map((entry) => ({ ...entry }))
    },
  }
}

/**
 * File-backed journal.
 *
 * @param {string} dir - where `archive-journal.json` lives
 */
export function createFileJournal(dir) {
  const file = join(dir, 'archive-journal.json')
  // A unique temp name keeps two instances from overwriting each other's write.\n  const temp = join(dir, 'archive-journal.json.' + process.pid + '.tmp')

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
      // Only a MISSING file is benign; anything else is a corrupt journal.
      corrupt = !(error && error.code === 'ENOENT')
      // A missing or corrupt journal is treated as empty: the service then falls
      // back to "no pending work", which is the safe direction (never invent a
      // trash entry that does not exist).
      return []
    }
  }

  function write(entries) {
    mkdirSync(dirname(file), { recursive: true })
    const payload = JSON.stringify({ v: 1, at: Date.now(), entries }, null, 2)
    try {
      writeFileSync(temp, payload, 'utf8')
      renameSync(temp, file)
    } catch (error) {
      // Never leave a half-written temp file behind.
      try {
        rmSync(temp, { force: true })
      } catch (cleanupError) {
        /* ignore */
      }
      throw error
    }
  }

  return {\n    read,\n    write,\n    // Ask the file, not a stale flag: callers check health BEFORE acting.\n    health() {\n      read()\n      return { corrupt }\n    },\n    path: file,\n  }
}
