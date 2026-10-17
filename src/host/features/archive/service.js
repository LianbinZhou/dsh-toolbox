/**
 * S4-b · the archive delete state machine (R4 / R5).
 *
 * The pre-migration algorithm was: check archived → find → remove → unarchive →
 * workspace → cache, with no lock, no live check, no re-read and a dead end when
 * the files were gone but the marker was not. Pi's list turns that into six
 * failures; this module is the answer.
 *
 * Invariants, in order of how much damage they prevent:
 *
 *   1. ONE delete per id at a time (per-id lock). Two concurrent requests cannot
 *      both reach the filesystem, and independent ids never block each other.
 *   2. The archived set and the live set are re-read IMMEDIATELY before the
 *      destructive step, so an unarchive or a session becoming live in the gap
 *      cancels the delete.
 *   3. The files are removed BEFORE any bookkeeping. If the removal fails, the
 *      archive marker is untouched, so the operation stays retryable.
 *   4. Bookkeeping failures never lose the ability to finish. The id is kept on a
 *      pending list, and `heal()` (also run by `list()`) retries it. That kills
 *      the "files gone, marker stuck forever" dead end.
 *   5. `archived + directory already gone` is CLEANUP-ONLY: it clears the
 *      bookkeeping and reports success instead of refusing forever.
 *   6. Every answer carries a stable machine code (`status` + `reason`), never a
 *      raw exception message, so the route and the UI can react without parsing
 *      English.
 *   7. The lock is always released, including on a thrown dependency.
 */

import { isSafeSessionId } from './paths.js'

/** Stable outcome codes (Pi's R4-4/R4-12: no free-text reasons on the wire). */
export const REASONS = {
  INVALID_ID: 'invalid-id',
  NOT_ARCHIVED: 'not-archived',
  LIVE: 'session-is-live',
  BECAME_LIVE: 'session-became-live',
  UNARCHIVED: 'no-longer-archived',
  DIR_MISSING: 'dir-missing',
  REMOVE_FAILED: 'remove-failed',
  CLEANUP_ONLY: 'cleanup-only',
  ALREADY_DELETED: 'already-deleted',
}

function contains(list, id) {
  return Array.isArray(list) && list.some((entry) => String(entry) === String(id))
}

/**
 * @param {object} deps
 * @param {() => string[]} deps.readArchived - DURABLE archived ids
 * @param {(id: string) => boolean} deps.isLive
 * @param {(id: string) => (string|undefined)} deps.findDir
 * @param {(dir: string) => void} deps.removeDir
 * @param {(id: string) => void} deps.unarchive
 * @param {(id: string) => void} deps.dropWorkspaceRows
 * @param {(id: string) => void} deps.scrubCache
 * @param {(step: string, id: string) => (Promise<void>|void)} [deps.beforeStep]
 */
export function createArchiveService(deps) {
  /** id -> tail of the per-id promise chain */
  const locks = new Map()
  /** ids whose bookkeeping failed; retried by heal()/list() */
  const pendingCleanup = new Set()

  async function withLock(id, run) {
    const previous = locks.get(id) || Promise.resolve()
    let release
    const mine = new Promise((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => mine)
    locks.set(id, tail)
    try {
      await previous.catch(() => {})
      return await run()
    } finally {
      release()
      if (locks.get(id) === tail) locks.delete(id)
    }
  }

  /** unarchive + workspace + cache; returns the names of the failed steps. */
  function cleanup(id) {
    const failed = []
    try {
      deps.unarchive(id)
    } catch (error) {
      failed.push('unarchive')
    }
    try {
      deps.dropWorkspaceRows(id)
    } catch (error) {
      failed.push('workspace')
    }
    try {
      deps.scrubCache(id)
    } catch (error) {
      failed.push('cache')
    }
    if (failed.length > 0) pendingCleanup.add(id)
    else pendingCleanup.delete(id)
    return failed
  }

  async function deleteSession(id) {
    if (!isSafeSessionId(id)) {
      return { ok: false, status: 400, reason: REASONS.INVALID_ID }
    }

    return withLock(id, async () => {
      // First read: is this even a candidate?
      if (!contains(deps.readArchived(), id)) {
        return { ok: false, status: 404, reason: REASONS.NOT_ARCHIVED }
      }
      if (deps.isLive(id)) {
        return { ok: false, status: 409, reason: REASONS.LIVE }
      }

      const dir = deps.findDir(id)
      if (dir === undefined) {
        // Invariant 5: the files are already gone. Clear the bookkeeping instead
        // of refusing forever (this was R5-1's dead end).
        const failed = cleanup(id)
        return failed.length === 0
          ? { ok: true, removedDir: false, reason: REASONS.CLEANUP_ONLY }
          : { ok: true, removedDir: false, reason: REASONS.CLEANUP_ONLY, warning: 'cleanup incomplete' }
      }

      if (typeof deps.beforeStep === 'function') await deps.beforeStep('rm', id)

      // Invariant 2: the destructive step gets a FRESH verdict.
      if (!contains(deps.readArchived(), id)) {
        return { ok: false, status: 409, reason: REASONS.UNARCHIVED }
      }
      if (deps.isLive(id)) {
        return { ok: false, status: 409, reason: REASONS.BECAME_LIVE }
      }

      // Invariant 3: files first. A failure here leaves every marker untouched.
      try {
        deps.removeDir(dir)
      } catch (error) {
        return { ok: false, status: 500, reason: REASONS.REMOVE_FAILED }
      }

      // Invariant 4: bookkeeping can be retried through heal().
      const failed = cleanup(id)
      return failed.length === 0
        ? { ok: true, removedDir: true }
        : { ok: true, removedDir: true, warning: 'deleted with warnings' }
    })
  }

  /** Retry every pending bookkeeping cleanup. Called by mount, heal() and list(). */
  function heal() {
    const healed = []
    const stillFailing = []
    for (const id of [...pendingCleanup]) {
      const failed = cleanup(id)
      if (failed.length === 0) healed.push(id)
      else stillFailing.push(id)
    }
    return { ok: true, healed, pending: stillFailing }
  }

  return {
    delete: deleteSession,
    heal,
    pendingCleanup: () => [...pendingCleanup],
    /** Rows for the panel; heals first so a ghost row cannot outlive a reload. */
    async list() {
      heal()
      return { ok: true, rows: deps.readArchived().map((id) => ({ id: String(id) })) }
    },
    async unarchiveSession(id) {
      if (!isSafeSessionId(id)) return { ok: false, status: 400, reason: REASONS.INVALID_ID }
      return withLock(id, async () => {
        if (!contains(deps.readArchived(), id)) {
          return { ok: false, status: 404, reason: REASONS.NOT_ARCHIVED }
        }
        deps.unarchive(id)
        return { ok: true }
      })
    },
  }
}
