/**
 * The defendant for Pi's D/T review: the TOMBSTONE service (commit 5d2997b).
 *
 * Faithful to what shipped, adapted to the v2 dependency contract so the same
 * matrix can run against both. Every flaw Pi named is annotated in place.
 */

import { isSafeSessionId } from '../../src/host/features/archive/paths.js'

export function createLegacyTombstoneService(deps) {
  const locks = new Map()
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

  function cleanup(id) {
    const failed = []
    try {
      deps.unarchive(id)
    } catch (error) {
      failed.push('unarchive') // FLAW D5: "already unarchived" counts as failure
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

  /** FLAW D3: heal bypasses the per-id lock entirely. */
  function heal() {
    const healed = []
    for (const id of [...pendingCleanup]) {
      if (cleanup(id).length === 0) healed.push(id)
    }
    return { ok: true, healed, pending: [...pendingCleanup] }
  }

  return {
    async delete(id) {
      if (!isSafeSessionId(id)) return { ok: false, status: 400, reason: 'invalid-id' }

      return withLock(id, async () => {
        // FLAW D4: the journal is never read or written, so a restart forgets
        // everything this service learned.
        if (!deps.readArchived().includes(id)) {
          return { ok: false, status: 404, reason: 'not-archived' }
        }
        if (deps.isLive(id)) return { ok: false, status: 409, reason: 'session-is-live' }

        const probe = deps.probe(id)
        // FLAW D1: `unsafe` and `error` collapse into "the files are gone", so a
        // permission error unarchives a session that still exists.
        if (probe.state !== 'present') {
          const failed = cleanup(id)
          return failed.length === 0
            ? { ok: true, removedDir: false, reason: 'cleanup-only' }
            : { ok: true, removedDir: false, reason: 'cleanup-only', warning: 'cleanup incomplete' }
        }

        // FLAW D2: nothing durable is written before the destructive step; the
        // recheck below happens before `beforeStep`, so an unarchive during the
        // pause is invisible.
        if (!deps.readArchived().includes(id)) {
          return { ok: false, status: 409, reason: 'no-longer-archived' }
        }
        if (deps.isLive(id)) return { ok: false, status: 409, reason: 'session-became-live' }

        // FLAW D7: no identity comparison — a swapped directory is removed.
        // FLAW T1/T3: no trash, no nonce, no same-volume check: it just deletes.
        try {
          deps.removeTree(probe.dir)
        } catch (error) {
          return { ok: false, status: 500, reason: 'remove-failed' }
        }

        const failed = cleanup(id)
        return failed.length === 0
          ? { ok: true, removedDir: true }
          : { ok: true, removedDir: true, warning: 'deleted with warnings' }
      })
    },

    heal,
    pendingCleanup: () => [...pendingCleanup],
    async list() {
      heal()
      return { ok: true, rows: deps.readArchived().map((id) => ({ id })) }
    },
    async restore() {
      return { ok: false, reason: 'not-implemented' }
    },
  }
}
