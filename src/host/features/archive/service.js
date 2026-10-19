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
  /**
   * 回收箱保留天数：deps.trashKeptDays 可能是函数（每次读最新配置），也可能是数值。
   * 非法或缺失都回落到 7 天。
   */
  function keptDays() {
    const raw = typeof deps.trashKeptDays === 'function' ? deps.trashKeptDays() : deps.trashKeptDays
    return Number.isFinite(raw) ? raw : 7
  }

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

  /**
   * 清掉归档标记，两种拼写都要清，而且要 await。
   *
   * 之前这里没 await：HTTP 早就回 200 了，标记可能还没落盘，用户看到的就是
   * 「删了但侧栏还在」。恢复路径也复用这个函数。
   */
  async function clearArchiveMarkers(id) {
    const failed = []
    let archived = []
    try {
      archived = deps.readArchived().map(String)
    } catch (error) {
      return { failed: ['read-archived'] }
    }
    for (const spelling of spellings(id)) {
      if (!archived.includes(spelling)) continue
      try {
        await deps.unarchive(spelling)
      } catch (error) {
        failed.push('unarchive:' + spelling)
      }
    }
    return { failed }
  }

  /** 删除后的账务清理：标记 + workspace 行 + projection cache，全部 await。 */
  async function cleanup(id, seat) {
    const failed = []
    // 删除路径也要清归档标记：否则归档集合一直指着一个已经不在 sessions 树里的会话，
    // DSH 的其他归档消费者会探测失败。侧栏残留由 dropWorkspaceRows 负责（摘行），
    // 两者配合才是「彻底消失」：标记清掉 + 行摘掉。
    const markers = await clearArchiveMarkers(id)
    failed.push(...markers.failed)
    if (typeof deps.dropWorkspaceRows === 'function') {
      try {
        const result = await deps.dropWorkspaceRows(id, seat)
        // 三种都算没做完（终审 P0-1）：
        //   ok === false     —— 没定位到工作区 / 没摘掉 / detach 无效果
        //   dropped === 0    —— 一个都没删，且拿不出「本来就干净」的证据
        // 返回非对象（老实现无返回值）：无法判断，不判失败，免得把兼容层判成崩溃。
        const why =
          result && typeof result === 'object'
            ? result.ok === false
              ? String(result.reason ?? 'unknown')
              : result.dropped === 0 && result.already !== true
                ? 'dropped-0'
                : null
            : null
        if (why !== null) {
          failed.push('workspace:' + why)
          console.error('[dsh-toolbox] cleanup workspace 未摘除 id=' + id + ' seat=' + JSON.stringify(seat ?? null) + ' reason=' + why)
        }
      } catch (error) {
        const detail = String((error && error.message) || error).slice(0, 200)
        failed.push('workspace-threw:' + detail)
        console.error('[dsh-toolbox] cleanup workspace 抛错 id=' + id + ' seat=' + JSON.stringify(seat ?? null), error)
      }
    }
    if (typeof deps.scrubCache === 'function') {
      try {
        await deps.scrubCache(id)
      } catch (error) {
        const detail = String((error && error.message) || error).slice(0, 200)
        failed.push('cache-threw:' + detail)
        console.error('[dsh-toolbox] cleanup cache 抛错 id=' + id, error)
      }
    }
    if (failed.length > 0) console.warn('[dsh-toolbox] cleanup 未完成 id=' + id + ': ' + failed.join(', '))
    return failed
  }

  /** Finish a `trashed`/`cleaned` entry. Caller holds the lock. */
  async function finish(id) {
    try {
      return await finishInner(id)
    } catch (error) {
      const detail = String((error && error.message) || error).slice(0, 160)
      console.error('[dsh-toolbox] finish 抛错 ' + id + ': ' + detail)
      try {
        deps.journal.update((entries) => entries.map((current) =>
          current.id === id ? { ...current, phase: 'trashed', lastError: 'threw: ' + detail } : current,
        ))
      } catch (writeError) {
        console.error('[dsh-toolbox] 连 lastError 都写不进去', writeError)
      }
      return { ok: false, status: 500, reason: 'finish-failed', detail }
    }
  }

  async function finishInner(id) {
    const entry = findEntry(deps.journal, id)
    console.info('[dsh-toolbox] finish(' + id + ') entry=' + (entry ? entry.phase : 'MISSING'))
    if (!entry) return { ok: true, removedDir: true }
    if (!entryIsSane(entry)) return { ok: false, status: 409, reason: 'journal-corrupt' }

    const failed = await cleanup(id, entry && entry.workspaceSeat)
    if (failed.length > 0) {
      // 清理没做完就**不许**标 cleaned：cleaned 的语义是「账已平」，标错了 heal
      // 会在每次启动时重跑同一条必然失败的清理，终端就成了复读机。
      const attempts = Number(entry.cleanupAttempts ?? 0) + 1
      const detail = failed.join(',').slice(0, 300)
      deps.journal.update((entries) => entries.map((current) =>
        current.id === id
          ? { ...current, phase: 'trashed', lastError: detail, cleanupAttempts: attempts, cleanupAt: Date.now() }
          : current,
      ))
      console.warn('[dsh-toolbox] cleanup 未完成（第 ' + attempts + ' 次），phase 保持 trashed：' + id + ' → ' + detail)
      return { ok: true, removedDir: true, reason: 'cleanup-pending', warning: 'deleted with warnings', detail }
    }

    deps.journal.update((entries) => entries.map((current) =>
      current.id === id
        ? { ...current, phase: 'cleaned', lastError: undefined, cleanupAttempts: 0 }
        : current,
    ))

    // 删除到此为止：目录已在垃圾箱里等保留期，绝不在这里物理清空；
    // 以前这里紧接着物理删除，一次误点就永久没了。
    // removedDir 的语义是「原位置已经清空」，移入垃圾箱后它依然成立；
    // movedToTrash / recoverable 说明它没有消失，还能捞回来。
    return {
      ok: true,
      removedDir: true,
      movedToTrash: true,
      recoverable: true,
      keptDays: keptDays(),
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
        // 先补清账务（标记/工作区行/缓存）：清不掉就不许物理删除，
        // 否则文件没了、workspace 行还在，就是幽灵。
        const pending = await cleanup(id, entry.workspaceSeat)
        if (pending.length > 0) {
          deps.journal.update((entries) => entries.map((current) =>
            current.id === id ? { ...current, phase: 'trashed', lastError: pending.join(',') } : current,
          ))
          return { ok: false, status: 409, reason: 'cleanup-pending' }
        }
      try {
        deps.removeTree(entry.trashPath)
      } catch (error) {
        if (!(error && error.code === 'ENOENT')) return { ok: false, status: 500, reason: 'purge-failed' }
      }
      // 文件真的没了，这时候才清归档标记：删路径时不清是为了让侧栏闭嘴，
      // 彻底删完还留着标记，归档集合里就会永远挂一个不存在的 id。
      const cleared = await clearArchiveMarkers(id)
      if (cleared.failed.length > 0) {
        console.warn('[dsh-toolbox] purge: 文件已删，归档标记未清干净 ' + id + ': ' + cleared.failed.join(','))
      }
      deps.journal.update((entries) => entries.filter((current) => current.id !== id))
      return { ok: true, purged: true }
    })
  }

  async function deleteSession(id, options) {
      const title = options && typeof options.title === 'string' ? options.title.slice(0, 120) : undefined
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
        const failed = await cleanup(id)
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
      // 移动前记下它在工作区里的位置：移动后 sessionIds 是 filtered getter，
      // 目录不在了就再也找不到这一行。
      const workspaceSeat = typeof deps.snapshotWorkspace === 'function' ? deps.snapshotWorkspace(id) : null
      console.info('[dsh-toolbox] 工作区快照 ' + id + ': ' + JSON.stringify(workspaceSeat))
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
        ...(workspaceSeat ? { workspaceSeat } : {}),
        // 记下标题：删完就不在归档集合里了，这是回收箱显示会话名的唯一来源。
        ...(title ? { title } : {}),
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

  const MAX_CLEANUP_ATTEMPTS = 3

  /** Retry every unfinished entry. Locked per id, like delete (D3). */
  async function heal() {
    const healed = []
    const pending = []
    for (const entry of deps.journal.read()) {
      if (entry.phase === 'done') continue
      // 连续失败到上限就不再自动重试：每次启动重跑同一条必然失败的清理只会把
      // 终端刷成复读机，状态还停在原地。用户手动「彻底删除」仍会再试一次。
      if (entry.lastError && Number(entry.cleanupAttempts ?? 0) >= MAX_CLEANUP_ATTEMPTS) {
        pending.push(entry.id)
        continue
      }
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
          // 「claim 写了但目录没动」才该删记录；这里记一笔，防止误删。
          console.warn('[dsh-toolbox] heal 丢弃 deleting 记录（垃圾箱里没找到目录）: ' + entry.id + ' trashPath=' + entry.trashPath)
          deps.journal.write(withoutEntry(deps.journal, entry.id))
        })
        healed.push(entry.id)
        continue
      }
      // cleaned 且没有 lastError = 终态：cleanup 已经成功过。
      // 以前这里也走 finish，于是每次 heal 都把同一批记录重新 detach 一遍——
      // 真机日志里那串 (60→60)/(59→59) 就是它：行早就不在了，流程还在空转。
      // 只有带 lastError 的 cleaned（上次清理没做完）才值得重试。
      if (entry.phase === 'cleaned' && !entry.lastError) continue
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
    // 幽灵态兜底：垃圾箱里要是没有东西，恢复只会在工作区里造出一行空记录，
    // 用户看到的就是「回收站有一份、未分组又冒一份」。
    // 这里直接拒绝，并把底层残留标记清干净。
    try {
      if (typeof deps.pathExists === 'function' && !deps.pathExists(entry.trashPath)) {
        await clearArchiveMarkers(id)
        return { ok: false, status: 409, reason: 'dir-absent' }
      }
    } catch (error) {
      /* 检查失败不拦恢复，交给下面的 rename 兜底 */
    }
    try {
      deps.renamePath(entry.trashPath, entry.originalPath)
    } catch (error) {
      return { ok: false, status: 500, reason: REASONS.RESTORE_FAILED }
    }
    // 4) 文件回来了，再按快照放回原工作区与位置。
    let reattached = false
    if (entry.workspaceSeat && typeof deps.reattach === 'function') {
      const placed = await deps.reattach(entry.workspaceSeat)
      reattached = placed && placed.ok === true
    }
    deps.journal.update((entries) => entries.filter((entry) => entry.id !== id))
    return { ok: true, restored: true, reattached }
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
        // journal 坏了就不能假装「回收箱是空的」。
        if (typeof deps.journal.health === 'function' && deps.journal.health().corrupt) {
          return { ok: false, reason: 'journal-corrupt' }
        }
        const rows = []
        const ttl = keptDays()
        for (const entry of deps.journal.read()) {
          if (!entry || (entry.phase !== 'cleaned' && entry.phase !== 'trashed')) continue
          rows.push({
            id: String(entry.id),
            title: typeof entry.title === 'string' ? entry.title : undefined,
            phase: entry.phase,
            keptDays: ttl,
            at: typeof entry.at === 'number' ? entry.at : 0,
            // 剩余天数必须按到期时间算：keptDays 是总期，不是剩余。
            expiresAt: typeof entry.at === 'number' ? entry.at + ttl * 24 * 60 * 60 * 1000 : 0,
            // 清理没做完的原因必须送到 UI：否则用户只看到条目躺在回收箱里，
            // 永远不知道为什么侧栏还留着它（终审 D5 的可见性要求）。
            ...(typeof entry.lastError === 'string' && entry.lastError !== ''
              ? { lastError: entry.lastError.slice(0, 200) }
              : {}),
            ...(Number.isFinite(entry.cleanupAttempts) ? { cleanupAttempts: entry.cleanupAttempts } : {}),
          })
        }
        const maxProtected = Number.isFinite(deps.maxProtected) ? deps.maxProtected : 200
        return { ok: true, rows, protectedCount: rows.length, keptDays: ttl, maxProtected }
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
        const entry = findEntry(deps.journal, String(raw))
        // 回收箱里的条目不算「归档」：用户已经从归档页删掉它了，只是还能恢复。
        // 不过滤的话，删掉的会话会同时出现在归档页和回收箱两个页签里。
        if (entry && (entry.phase === 'trashed' || entry.phase === 'cleaned')) continue
        seen.add(canonical)
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
          // 两种拼写都清，而且 await——以前只清一个拼写、也不等结果。
          const cleared = await clearArchiveMarkers(id)
          if (cleared.failed.length > 0) {
            return { ok: true, restored: true, warning: 'cleanup-pending' }
          }
          return { ok: true, restored: true }
        }
        // 幽灵态兜底：目录已经不在了，就别再「取消归档」——那会让它变成一条
        // 没有文件的工作区记录，用户看到的就是「未分组」里冒出一份。
        try {
          const probed = typeof deps.probe === 'function' ? deps.probe(id) : { state: 'present' }
          if (probed && probed.state === 'absent') {
            await clearArchiveMarkers(id)
            return { ok: false, status: 409, reason: 'dir-absent' }
          }
        } catch (error) {
          /* 探测失败不拦，交给下面的常规分支 */
        }
        if (!deps.readArchived().includes(id)) {
          return { ok: false, status: 404, reason: REASONS.NOT_ARCHIVED }
        }
        // 官方 unarchiveSession 是 async：不 await 就会出现「接口已返回 ok、
        // 归档标记还在」的短暂不一致（终审 P1-2）。复用 clearArchiveMarkers：
        // 它遍历 bare / session- 双拼写并逐个 await。
        const cleared = await clearArchiveMarkers(id)
        if (cleared.failed.length > 0) {
          return { ok: true, restored: true, warning: 'cleanup-pending', detail: cleared.failed.join(',') }
        }
        return { ok: true, restored: true }
      })
    },
  }
}
