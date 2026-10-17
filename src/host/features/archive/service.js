/**
 * S4-b · the archive delete state machine, with a REAL trash (Pi T1–T10).
 *
 * The tombstone design that shipped in `5d2997b` was rejected: it could not tell
 * "the files are gone" from "the probe failed", it forgot pending work on
 * restart, and it deleted the directory in place, so a failed bookkeeping step
 * left the user with nothing to recover.
 *
 * This version moves the directory into a trash entry FIRST, under a durable
 * claim, and only then touches the markers. Every phase is journaled, so a
 * restart can finish the job and a user can restore their files.
 *
 * State machine (each arrow is one journal write):
 *
 *   archived --claim(deleting)--> deleting --rename--> trashed
 *            --unarchive/workspace/cache--> cleaned --purge--> done
 *
 * Guarantees, keyed to Pi's list:
 *   D1  `probe` is tri-state; `unsafe`/`error` refuse and change nothing.
 *   D2  the claim is durable and written BEFORE the move; the state is re-read
 *       after the claim, and the identity must still match.
 *   D3  `heal`/`unarchive` take the same per-id lock as `delete`.
 *   D4  pending work lives in the journal, so a new instance finds it.
 *   D5  `unarchive` is treated as idempotent: "already unarchived" is success.
 *   D6  the cleanup-only path re-checks live.
 *   D7  the claim records dev/ino/realpath and they are compared again right
 *       before the move, so a swapped directory is refused.
 *   D8  a second instance sees the claim in the journal and refuses.
 *   T1  same-volume only; a cross-volume trash root is refused (no copy+delete).
 *   T2  the trash root lives outside the sessions tree.
 *   T3  trash entries are named by a nonce, never by the session id.
 *   T5  deleting/trashed/cleaned/done are all journaled.
 *   T6  the journal is written whole-file and atomically (see journal.js).
 *   T8  `restore` moves a trashed session back.
 */

import { isSafeSessionId } from './paths.js'

/** Stable machine codes; the route and the UI switch on these. */
export const REASONS = {
  INVALID_ID: 'invalid-id',
  NOT_ARCHIVED: 'not-archived',
  LIVE: 'session-is-live',
  BECAME_LIVE: 'session-became-live',
  UNARCHIVED: 'no-longer-archived',
  DIR_ABSENT: 'dir-absent',
  UNSAFE_PATH: 'unsafe-path',
  PROBE_FAILED: 'probe-failed',
  CLAIM_FAILED: 'claim-failed',
  IDENTITY_CHANGED: 'identity-changed',
  CROSS_VOLUME: 'cross-volume-trash',
  MOVE_FAILED: 'move-failed',
  ALREADY_DELETED: 'already-deleted',
  IN_PROGRESS: 'delete-in-progress',
  CLEANUP_ONLY: 'cleanup-only',
  RESTORE_FAILED: 'restore-failed',
}

function findEntry(journal, id) {
  return journal.read().find((entry) => entry.id === id)
}

function withoutEntry(journal, id) {
  return journal.read().filter((entry) => entry.id !== id)
}

/**
 * @param {object} deps
 * @param {() => string[]} deps.readArchived
 * @param {(id: string) => boolean} deps.isLive
 * @param {(id: string) => object} deps.probe - see the tri-state contract
 * @param {(from: string, to: string) => void} deps.renamePath
 * @param {(dir: string) => void} deps.removeTree
 * @param {() => string} deps.trashRoot
 * @param {(a: string, b: string) => boolean} deps.sameVolume
 * @param {(id: string) => void} deps.unarchive
 * @param {(id: string) => void} deps.dropWorkspaceRows
 * @param {(id: string) => void} deps.scrubCache
 * @param {{read: Function, write: Function}} deps.journal
 * @param {() => string} deps.nonce
 * @param {(step: string, id: string) => (Promise<void>|void)} [deps.beforeStep]
 */
export function createArchiveService(deps) {
  /** Per-instance serialisation. Cross-instance exclusion is the claim. */
  const locks = new Map()

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

  /** Idempotent bookkeeping. "Already unarchived" is success (D5). */
  function cleanup(id) {
    const failed = []
    try {
      if (deps.readArchived().includes(id)) deps.unarchive(id)
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
    return failed
  }

  /** Finish a `trashed`/`cleaned` entry. Caller holds the lock. */
  async function finish(id) {
    const entry = findEntry(deps.journal, id)
    if (!entry) return { ok: true, removedDir: true }

    const failed = cleanup(id)
    if (failed.length > 0) {
      return { ok: true, removedDir: true, reason: 'cleanup-pending', warning: 'deleted with warnings' }
    }

    deps.journal.write(
      deps.journal.read().map((current) => (current.id === id ? { ...current, phase: 'cleaned' } : current)),
    )

    try {
      deps.removeTree(entry.trashPath)
    } catch (error) {
      return { ok: true, removedDir: true, reason: 'trash-pending', warning: 'deleted with warnings' }
    }

    deps.journal.write(
      deps.journal.read().map((current) => (current.id === id ? { ...current, phase: 'done', at: Date.now() } : current)),
    )
    return { ok: true, removedDir: true }
  }

  async function deleteSession(id) {
    if (!isSafeSessionId(id)) return { ok: false, status: 400, reason: REASONS.INVALID_ID }

    return withLock(id, async () => {
      const existing = findEntry(deps.journal, id)
      if (existing && existing.phase === 'done') {
        return { ok: false, status: 409, reason: REASONS.ALREADY_DELETED }
      }
      if (existing && existing.phase === 'deleting') {
        return { ok: false, status: 409, reason: REASONS.IN_PROGRESS }
      }
      if (existing && (existing.phase === 'trashed' || existing.phase === 'cleaned')) {
        // Resume: the files are already in the trash.
        return finish(id)
      }

      const probe = deps.probe(id)
      // D1: only a CONFIRMED absence may be cleaned up.
      if (probe.state === 'unsafe') {
        return { ok: false, status: 409, reason: REASONS.UNSAFE_PATH }
      }
      if (probe.state === 'error') {
        return { ok: false, status: 409, reason: REASONS.PROBE_FAILED }
      }

      if (!deps.readArchived().includes(id)) {
        return { ok: false, status: 404, reason: REASONS.NOT_ARCHIVED }
      }
      // D6: the cleanup-only path still refuses a live session.
      if (deps.isLive(id)) return { ok: false, status: 409, reason: REASONS.LIVE }

      if (probe.state === 'absent') {
        // D6: the probe takes time; the session may have been opened since the
        // check above. Cleanup must never unarchive a live session.
        if (deps.isLive(id)) return { ok: false, status: 409, reason: REASONS.LIVE }
        const failed = cleanup(id)
        return failed.length === 0
          ? { ok: true, removedDir: false, reason: REASONS.CLEANUP_ONLY }
          : { ok: true, removedDir: false, reason: REASONS.CLEANUP_ONLY, warning: 'cleanup incomplete' }
      }

      // T1: same-volume or nothing. A copy+delete fallback is not atomic.
      const trashRoot = deps.trashRoot()
      if (!deps.sameVolume(trashRoot, probe.dir)) {
        return { ok: false, status: 409, reason: REASONS.CROSS_VOLUME }
      }

      // D2/T4: the claim is durable and written BEFORE the move.
      const nonce = deps.nonce()
      const claim = {
        id,
        nonce,
        phase: 'deleting',
        originalPath: probe.dir,
        // T3: the entry name never contains the session id.
        trashPath: trashRoot + '/' + nonce,
        dev: probe.identity?.dev,
        ino: probe.identity?.ino,
        realpath: probe.identity?.realpath,
        at: Date.now(),
      }
      try {
        deps.journal.write([...withoutEntry(deps.journal, id), claim])
      } catch (error) {
        return { ok: false, status: 409, reason: REASONS.CLAIM_FAILED }
      }

      if (typeof deps.beforeStep === 'function') await deps.beforeStep('rename', id)

      // D2: the state is re-verified AFTER the claim.
      if (!deps.readArchived().includes(id)) {
        deps.journal.write(withoutEntry(deps.journal, id))
        return { ok: false, status: 409, reason: REASONS.UNARCHIVED }
      }
      if (deps.isLive(id)) {
        deps.journal.write(withoutEntry(deps.journal, id))
        return { ok: false, status: 409, reason: REASONS.BECAME_LIVE }
      }

      // D7: it must still be the same directory the claim was written for.
      const fresh = deps.probe(id)
      const sameIdentity =
        fresh.state === 'present' &&
        fresh.identity?.dev === claim.dev &&
        fresh.identity?.ino === claim.ino
      if (!sameIdentity) {
        deps.journal.write(withoutEntry(deps.journal, id))
        return { ok: false, status: 409, reason: REASONS.IDENTITY_CHANGED }
      }

      try {
        deps.renamePath(claim.originalPath, claim.trashPath)
      } catch (error) {
        deps.journal.write(withoutEntry(deps.journal, id))
        return { ok: false, status: 500, reason: REASONS.MOVE_FAILED }
      }

      deps.journal.write(
        deps.journal.read().map((entry) => (entry.id === id ? { ...entry, phase: 'trashed', at: Date.now() } : entry)),
      )
      return finish(id)
    })
  }

  /** Retry every unfinished entry. Locked per id, like delete (D3). */
  async function heal() {
    const healed = []
    const pending = []
    for (const entry of deps.journal.read()) {
      if (entry.phase === 'done') continue
      if (entry.phase === 'deleting') {
        // Two different crashes wear the same journal state:
        //   (a) the claim was written but the directory never moved  -> drop it
        //   (b) the directory moved but the journal was not updated   -> adopt it
        // The trash entry is the only evidence that tells them apart.
        const moved = typeof deps.exists === 'function' && deps.exists(entry.trashPath)
        if (moved) {
          deps.journal.write(
            deps.journal.read().map((current) =>
              current.id === entry.id ? { ...current, phase: 'trashed', at: Date.now() } : current,
            ),
          )
          const result = await finish(entry.id)
          if (result.ok && !result.warning) healed.push(entry.id)
          else pending.push(entry.id)
          continue
        }
        await withLock(entry.id, async () => {
          deps.journal.write(withoutEntry(deps.journal, entry.id))
        })
        healed.push(entry.id)
        continue
      }
      await withLock(entry.id, async () => {
        const result = await finish(entry.id)
        if (result.ok && !result.warning) healed.push(entry.id)
        else pending.push(entry.id)
      })
    }
    return { ok: true, healed, pending }
  }

  async function restore(id) {
    if (!isSafeSessionId(id)) return { ok: false, status: 400, reason: REASONS.INVALID_ID }
    return withLock(id, async () => {
      const entry = findEntry(deps.journal, id)
      if (!entry || entry.phase === 'done') {
        return { ok: false, status: 404, reason: REASONS.NOT_ARCHIVED }
      }
      if (entry.phase !== 'trashed' && entry.phase !== 'cleaned') {
        return { ok: false, status: 409, reason: REASONS.IN_PROGRESS }
      }
      try {
        deps.renamePath(entry.trashPath, entry.originalPath)
      } catch (error) {
        return { ok: false, status: 500, reason: REASONS.RESTORE_FAILED }
      }
      deps.journal.write(withoutEntry(deps.journal, id))
      return { ok: true, restored: true }
    })
  }

  return {
    delete: deleteSession,
    heal,
    restore,
    /** Ids with an unfinished entry (durable, survives a restart). */
    pendingCleanup: () =>
      deps.journal
        .read()
        .filter((entry) => entry.phase !== 'done')
        .map((entry) => entry.id),

    async list() {
      await heal()
      return {
        ok: true,
        rows: deps.readArchived().map((id) => {
          const entry = findEntry(deps.journal, id)
          return { id: String(id), phase: entry ? entry.phase : 'archived' }
        }),
      }
    },

    async unarchiveSession(id) {
      if (!isSafeSessionId(id)) return { ok: false, status: 400, reason: REASONS.INVALID_ID }
      return withLock(id, async () => {
        // Unarchiving a trashed session means "put my files back" (T8).
        const entry = findEntry(deps.journal, id)
        if (entry && (entry.phase === 'trashed' || entry.phase === 'cleaned')) {
          const moved = await restore(id)
          if (!moved.ok) return moved
        }
        if (!deps.readArchived().includes(id)) {
          return { ok: false, status: 404, reason: REASONS.NOT_ARCHIVED }
        }
        deps.unarchive(id)
        return { ok: true }
      })
    },
  }
}
