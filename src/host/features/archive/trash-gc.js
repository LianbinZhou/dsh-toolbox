/**
 * S4-b · trash garbage collection (Pi T9) and safe removal (Pi T10).
 *
 * A trash that only grows is a second disk-full bug. Two rules:
 *
 *   T9  An entry is purged when it is finished, or orphaned and older than the
 *       TTL, or when the trash exceeds its capacity — oldest first. An entry that
 *       is still `trashed`/`cleaned` is NEVER purged by pressure: it is the only
 *       copy of the user's files, and `restore` must keep working.
 *   T10 Removal walks the tree with `lstat` and unlinks any link instead of
 *       following it, so a junction inside a trash entry cannot reach the rest of
 *       the disk. The target must also still resolve inside the trash root.
 */

import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isInside } from './paths.js'

/**
 * Remove one trash entry without ever following a link.
 *
 * @param {string} dir - the entry to remove
 * @param {string} trashRoot - the boundary it must stay inside
 */
export function removeTrashTree(dir, trashRoot) {
  const rootReal = realpathSync(trashRoot)
  const real = realpathSync(dir)
  if (real === rootReal) throw new Error('refusing to remove the trash root itself')
  if (!isInside(rootReal, real)) throw new Error('refusing to remove a path outside the trash root')
  walk(real)
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      // T10: unlink the link itself. Following it would delete whatever it points
      // at, which is exactly the bug this guard exists to prevent.
      unlinkSync(path)
      continue
    }
    if (stat.isDirectory()) walk(path)
    else unlinkSync(path)
  }
  rmdirSync(dir)
}

/**
 * Decide what to purge.
 *
 * @param {object} options
 * @param {() => Array<{path: string, at?: number}>} options.listTrash
 * @param {{read: Function}} options.journal
 * @param {(path: string) => void} options.remove - usually removeTrashTree bound to the root
 * @param {number} [options.ttlMs] - how long an orphan may stay
 * @param {number} [options.maxEntries] - hard cap after the purge
 * @param {() => number} [options.now]
 */
export function createTrashGc({
  listTrash,
  journal,
  remove,
  ttlMs = 7 * 24 * 60 * 60 * 1000,
  maxEntries = 200,
  now = () => Date.now(),
} = {}) {
  function run() {
    const at = now()
    const entries = (typeof listTrash === 'function' ? listTrash() : []).map((entry) => ({
      path: entry.path,
      at: Number.isFinite(entry.at) ? entry.at : 0,
    }))

    const byTrashPath = new Map()
    for (const record of journal.read()) {
      if (record && record.trashPath) byTrashPath.set(record.trashPath, record)
    }

    const purged = []
    const kept = []

    for (const entry of entries) {
      const record = byTrashPath.get(entry.path)
      if (record) {
        // Finished work: purge immediately.
        if (record.phase === 'done') {
          remove(entry.path)
          purged.push(entry.path)
          continue
        }
        // Still restorable: never purge under pressure.
        kept.push({ ...entry, protectedBy: record.phase })
        continue
      }
      // Orphan (no journal entry): purge only once it is old enough.
      if (at - entry.at >= ttlMs) {
        remove(entry.path)
        purged.push(entry.path)
        continue
      }
      kept.push(entry)
    }

    // Capacity: purge the oldest UNPROTECTED entries until the cap is met.
    const unprotected = kept.filter((entry) => entry.protectedBy === undefined).sort((a, b) => a.at - b.at)
    let remaining = kept.length
    const protectedCount = kept.length - unprotected.length
    for (const entry of unprotected) {
      if (remaining <= maxEntries) break
      remove(entry.path)
      purged.push(entry.path)
      remaining -= 1
    }

    return { purged, kept: remaining, protected: protectedCount }
  }

  return { run }
}
