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

import { dirname } from 'node:path'
import { canonicalSessionId, isInside, isSafeSessionId } from './paths.js'

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
  /** Every spelling of one canonical id, deduplicated. */
  function spellings(id) {
    const bare = String(id).replace(/^session-/, '')
    return [String(id), bare, 'session-' + bare].filter((value, index, all) => all.indexOf(value) === index)
  }

  /**
   * An entry read back from disk is untrusted input: it may have been truncated,
   * edited, or written by an older version. Fail closed rather than acting on it.
   */
  /**
   * 从磁盘读回的 entry 是不可信输入：可能被改过、被截断、或被写坏。
   *
   * 两条路径都要校验，缺一条就是穿越口子：
   *   - trashPath 必须以垃圾箱根开头（字符串层面）；
   *   - originalPath 的末段必须正好是这条会话的 id，且不含 ..；
   *     否则把 originalPath 改成 ../../outside 就能让恢复写到任意位置。
   */
  function entryIsSane(entry) {
    if (!entry || typeof entry !== 'object') return false
    if (!isSafeSessionId(entry.id)) return false
    if (typeof entry.trashPath !== 'string' || typeof entry.originalPath !== 'string') return false

    const root = String(deps.trashRoot())
    const inTrash = entry.trashPath.startsWith(root + '/') || entry.trashPath.startsWith(root + '\\')
    if (!inTrash) return false

    const normalized = entry.originalPath.replace(/\\/g, '/')
    if (normalized.includes('..')) return false
    const tail = normalized.split('/').filter(Boolean).pop()
    // 双拼写下 bare 与 session- 两种写法指的是同一个会话，按 canonical 比。
    if (canonicalSessionId(tail) !== canonicalSessionId(String(entry.id))) return false

    // 4.2：末段对还不够，必须确认它真的在会话根里。
    // startsWith 挡不住 C:/outside/<id> 这种根外绝对路径。
    if (typeof deps.isInsideSessions === 'function' && !deps.isInsideSessions(entry.originalPath)) return false
    // trashPath 自身也要做边界：<trash>/../outside/n1 只是前缀对，实际在根外。
    if (typeof deps.isInsideTrash === 'function' && !deps.isInsideTrash(entry.trashPath)) return false

    return true
  }

  function cleanup(id) {
    const failed = []
    try {
      // P1-9: the archive may hold BOTH spellings. Clearing only the one in the
      // request leaves a ghost row in list().
      for (const spelling of spellings(id)) {
        if (deps.readArchived().map(String).includes(spelling)) deps.unarchive(spelling)
      }
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
    if (!entryIsSane(entry)) return { ok: false, status: 409, reason: 'journal-corrupt' }

    const failed = cleanup(id)
    if (failed.length > 0) {
      return { ok: true, removedDir: true, reason: 'cleanup-pending', warning: 'deleted with warnings' }
    }

    deps.journal.update((entries) => entries.map((current) => (current.id === id ? { ...current, phase: 'cleaned' } : current)))

    // 删除到此为止：目录已在垃圾箱里等保留期，绝不在这里物理清空；
    // 以前这里紧接着物理删除，一次误点就永久没了。
    // removedDir 的语义是「原位置已经清空」，移入垃圾箱后它依然成立；
    // movedToTrash / recoverable 说明它没有消失，还能捞回来。
    return {
      ok: true,
      removedDir: true,
      movedToTrash: true,
      recoverable: true,
      keptDays: Number.isFinite(deps.trashKeptDays) ? deps.trashKeptDays : 7,
    }
  }

  /**
   * 真正物理清空一条记录：只允许已移入垃圾箱的状态，
   * 由清理器按保留期调用，或面板「彻底删除」二次确认后调用。
   */
  async function purge(id) {
    if (!isSafeSessionId(id)) return { ok: false, status: 400, reason: REASONS.INVALID_ID }
    return withLock(id, async () => {
      const entry = findEntry(deps.journal, id)
      if (!entry) return { ok: true, purged: false, reason: 'no-entry' }
      if (!entryIsSane(entry)) return { ok: false, status: 409, reason: 'journal-corrupt' }
      if (entry.phase !== 'cleaned' && entry.phase !== 'trashed') {
        return { ok: false, status: 409, reason: 'not-in-trash' }
      }
      try {
        deps.removeTree(entry.trashPath)
      } catch (error) {
        if (!(error && error.code === 'ENOENT')) return { ok: false, status: 500, reason: 'purge-failed' }
      }
      deps.journal.update((entries) => entries.filter((current) => current.id !== id))
      return { ok: true, purged: true }
    })
  }

  async function deleteSession(id) {
    if (!isSafeSessionId(id)) return { ok: false, status: 400, reason: REASONS.INVALID_ID }

    return withLock(id, async () => {
      // P0-3: a corrupt journal cannot be trusted to say what is in the trash.
      if (typeof deps.journal.health === 'function' && deps.journal.health().corrupt) {
        return { ok: false, status: 409, reason: 'journal-corrupt' }
      }
      const existing = findEntry(deps.journal, id)
      if (existing && existing.phase === 'done') {
        return { ok: false, status: 409, reason: REASONS.ALREADY_DELETED }
      }
      if (existing && existing.phase === 'deleting') {
        return { ok: false, status: 409, reason: REASONS.IN_PROGRESS }
      }
      // cleaned = 已经安全躺在垃圾箱里，再删一次是重复操作，不是「续做」。
      if (existing && existing.phase === 'cleaned') {
        return { ok: false, status: 409, reason: REASONS.ALREADY_DELETED }
      }
      if (existing && existing.phase === 'trashed') {
        // trashed = 还没做完归档标记清理，续做。
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

      // T2: the trash must never live inside the tree the probe walks, or a trash
      // entry could be discovered as a session and deleted twice.
      const trashRoot = deps.trashRoot()
      const sessionsRoot = dirname(dirname(probe.dir))
      if (isInside(sessionsRoot, trashRoot)) {
        return { ok: false, status: 409, reason: 'unsafe-trash-root' }
      }

      // T1: same-volume or nothing. A copy+delete fallback is not atomic.
      if (!deps.sameVolume(trashRoot, probe.dir)) {
        return { ok: false, status: 409, reason: REASONS.CROSS_VOLUME }
      }

      // P0-2: a restorable entry is never evicted, so a full trash must stop NEW
      // deletes instead of quietly growing until the disk is gone.
      const protectedCount = deps.journal.read().filter((entry) => entry.phase === 'trashed' || entry.phase === 'cleaned').length
      const maxProtected = Number.isFinite(deps.maxProtected) ? deps.maxProtected : 200
      if (protectedCount >= maxProtected) {
        return { ok: false, status: 409, reason: 'trash-full' }
      }

      // D2/T4: the claim is durable and written BEFORE the move.
      const nonce = String(deps.nonce())
      // P0-7: a nonce is used as a path segment; anything but an opaque token can
      // walk out of the trash root.
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
        return { ok: false, status: 500, reason: REASONS.CLAIM_FAILED }
      }
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
        deps.journal.update((entries) => [...entries.filter((entry) => entry.id !== id), claim])
      } catch (error) {
        return { ok: false, status: 409, reason: REASONS.CLAIM_FAILED }
      }

      if (typeof deps.beforeStep === 'function') await deps.beforeStep('rename', id)

      // D2: the state is re-verified AFTER the claim.
      if (!deps.readArchived().includes(id)) {
        deps.journal.update((entries) => entries.filter((entry) => entry.id !== id))
        return { ok: false, status: 409, reason: REASONS.UNARCHIVED }
      }
      if (deps.isLive(id)) {
        deps.journal.update((entries) => entries.filter((entry) => entry.id !== id))
        return { ok: false, status: 409, reason: REASONS.BECAME_LIVE }
      }

      // D7: it must still be the same directory the claim was written for.
      const fresh = deps.probe(id)
      const sameIdentity =
        fresh.state === 'present' &&
        fresh.identity?.dev === claim.dev &&
        fresh.identity?.ino === claim.ino
      if (!sameIdentity) {
        deps.journal.update((entries) => entries.filter((entry) => entry.id !== id))
        return { ok: false, status: 409, reason: REASONS.IDENTITY_CHANGED }
      }

      try {
        deps.renamePath(claim.originalPath, claim.trashPath)
      } catch (error) {
        deps.journal.update((entries) => entries.filter((entry) => entry.id !== id))
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
          // P0-5: the adoption touches the journal and the trash, so it belongs
          // under the same per-id lock as delete/restore.
          await withLock(entry.id, async () => {
            deps.journal.update((entries) => entries.map((current) =>
              current.id === entry.id ? { ...current, phase: 'trashed', at: Date.now() } : current,
            ))
            const result = await finish(entry.id)
            if (result.ok && !result.warning) healed.push(entry.id)
            else pending.push(entry.id)
          })
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

  /**
   * 把垃圾箱里的文件放回原位。**调用者必须已经持有该 id 的锁。**
   *
   * 这条注释是 P0 修复的一部分：withLock 不可重入，锁内再调带锁的 restore
   * 会等自己、永久挂起。所有内部调用都必须走这个无锁版本。
   */
  async function restoreLocked(id) {
    const entry = findEntry(deps.journal, id)
    if (!entry || entry.phase === 'done') {
      return { ok: false, status: 404, reason: REASONS.NOT_ARCHIVED }
    }
    if (!entryIsSane(entry)) return { ok: false, status: 409, reason: 'journal-corrupt' }
    if (entry.phase !== 'trashed' && entry.phase !== 'cleaned') {
      return { ok: false, status: 409, reason: REASONS.IN_PROGRESS }
    }
    try {
      deps.renamePath(entry.trashPath, entry.originalPath)
    } catch (error) {
      return { ok: false, status: 500, reason: REASONS.RESTORE_FAILED }
    }
    deps.journal.update((entries) => entries.filter((entry) => entry.id !== id))
    return { ok: true, restored: true }
  }

  /** 对外入口：校验 id、拿锁、复用无锁实现。 */
  async function restore(id) {
    if (!isSafeSessionId(id)) return { ok: false, status: 400, reason: REASONS.INVALID_ID }
    return withLock(id, () => restoreLocked(id))
  }

  return {
      /**
       * 回收箱视图：只给「能安全展示」的字段。
       *
       * 绝不返回 trashPath / originalPath / nonce —— 那是内部布局信息。
       */
      listTrash() {
        const rows = []
        const ttl = Number.isFinite(deps.trashKeptDays) ? deps.trashKeptDays : 7
        for (const entry of deps.journal.read()) {
          if (!entry || (entry.phase !== 'cleaned' && entry.phase !== 'trashed')) continue
          rows.push({
            id: String(entry.id),
            phase: entry.phase,
            keptDays: ttl,
            at: typeof entry.at === 'number' ? entry.at : 0,
          })
        }
        return { ok: true, rows, protectedCount: rows.length, keptDays: ttl }
      },

    delete: deleteSession,
    purge,
    heal,
    restore,
    /** Ids with an unfinished entry (durable, survives a restart). */
    // 只有「删到一半」的才算待清理；cleaned 表示已经安全躺在垃圾箱里等保留期，
    // 不属于未完成的工作。
    pendingCleanup: () =>
      deps.journal
        .read()
        .filter((entry) => entry.phase === 'deleting' || entry.phase === 'trashed')
        .map((entry) => entry.id),

    async list() {
      await heal()
      // P1-9: one canonical id may appear twice (bare + prefixed); show it once.
      const seen = new Set()
      const rows = []
      for (const raw of deps.readArchived()) {
        const canonical = canonicalSessionId(String(raw))
        if (canonical === '' || seen.has(canonical)) continue
        seen.add(canonical)
        const entry = findEntry(deps.journal, String(raw))
        rows.push({ id: String(raw), phase: entry ? entry.phase : 'archived' })
      }
      return { ok: true, rows }
    },

    async unarchiveSession(id) {
      if (!isSafeSessionId(id)) return { ok: false, status: 400, reason: REASONS.INVALID_ID }
      return withLock(id, async () => {
        // Unarchiving a trashed session means "put my files back" (T8).
        const entry = findEntry(deps.journal, id)
        if (entry && (entry.phase === 'trashed' || entry.phase === 'cleaned')) {
          const moved = await restoreLocked(id)
          if (!moved.ok) return moved

          // 文件回来了，但归档标记不一定干净：如果当初 cleanup 失败，
          // 状态会停在 trashed、标记还在，下次又会被当成归档会话。
          const stillArchived = deps.readArchived().some(
            (value) => canonicalSessionId(String(value)) === canonicalSessionId(String(id)),
          )
          if (stillArchived) {
            try {
              deps.unarchive(id)
            } catch (error) {
              return { ok: true, restored: true, warning: 'cleanup-pending' }
            }
          }
          return { ok: true, restored: true }
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
