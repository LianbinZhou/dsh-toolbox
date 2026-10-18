/**
 * S4-c · the real session adapter (Pi's contract).
 *
 * Which service owns what — verified against the harness, not guessed:
 *
 *   archived set   `ctx.workspaceRegistry.archivedSessionIds` (a getter)
 *   archive/unarchive  `workspaceRegistry.archiveSession()` / `unarchiveSession()`
 *   live           `ctx.sessions.get(id) !== undefined` (cheapest and exact)
 *   titles/search  `ctx.sessionQuery` — NOT an archive source, and listSessions()
 *                  is a full-corpus call that would be slow and racy here
 *
 * Fail closed everywhere:
 *   - no workspaceRegistry  => no adapter at all (the feature stays off, rather
 *     than writing to storage ourselves and ending up memory-archived/disk-not);
 *   - a throwing getter or an unknown live state => treated as LIVE, so delete
 *     refuses instead of removing something that may be open.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { canonicalSessionId, dshHome, sessionsRootFor } from './paths.js'
import { createFsProbe } from './probe.js'

/**
 * @param {object} options
 * @param {object} options.registry - ctx.workspaceRegistry
 * @param {object} options.sessions - ctx.sessions
 * @param {string} [options.sessionsRoot]
 * @returns {object|null} the adapter, or null when the registry is missing
 */
export function createSessionAdapter({ registry, sessions, sessionsRoot, storageFallback } = {}) {
  // A registry is what makes UNARCHIVE possible, but it is not what makes the
  // LIST possible: the archived ids are also persisted on disk. Degrading to
  // read-only beats showing the user an empty list when the seam is unavailable.
  const hasRegistry = Boolean(registry && typeof registry === 'object')
  const canUnarchive = Boolean(hasRegistry && typeof registry.unarchiveSession === 'function')
  if (!hasRegistry && typeof storageFallback !== 'function' && typeof dshHome !== 'function') return null

  /**
   * The archived set, read TOLERANTLY.
   *
   * The same field is an array on one face, a function on another, and an
   * observable on a third. Reading only the array shape silently produced [] —
   * which looked exactly like "the user has no archived sessions".
   */
  const readArchived = () => {
    let ids
    try {
      ids = hasRegistry ? registry.archivedSessionIds : undefined
      if (typeof ids === 'function') ids = ids.call(registry)
      if (ids && typeof ids.getSnapshot === 'function') ids = ids.getSnapshot()
      else if (ids && typeof ids.get === 'function') ids = ids.get()
      else if (ids && typeof ids.current === 'function') ids = ids.current()
    } catch (error) {
      // A throwing getter must NOT look like an empty archive set. Fall through
      // to the persisted unit, which is the same data the registry writes.
      console.warn('[dsh-toolbox] reading archivedSessionIds failed; falling back to storage', error)
      ids = undefined
    }
    let list = []
    if (Array.isArray(ids)) list = ids
    else if (ids instanceof Set) list = [...ids]
    else if (ids && typeof ids[Symbol.iterator] === 'function') list = [...ids]

    if (list.length === 0) {
      // Fallback: the registry's getter answered empty while the persisted unit
      // still holds the ids. Same data, read from the storage file it is written
      // from, so a broken seam does not look like "no archived sessions".
      list = typeof storageFallback === 'function' ? storageFallback() : readArchivedFromStorage()
    }
    return list.map(String)
  }

  /**
   * The persisted archive set, used only when the registry seam answers empty.
   *
   * The home directory can resolve differently inside the host process, so every
   * plausible root is tried and the one that worked is logged once.
   */
  let storageRoot = null
  function candidateHomes() {
    const out = []
    const push = (value) => {
      if (typeof value === 'string' && value.length > 0 && !out.includes(value)) out.push(value)
    }
    try {
      push(process.env.DSH_HOME)
    } catch (error) {
      /* ignore */
    }
    try {
      push(dshHome())
    } catch (error) {
      /* ignore */
    }
    try {
      push(join(homedir(), '.dsh'))
    } catch (error) {
      /* ignore */
    }
    return out
  }

  function readArchivedFromStorage() {
    let empty = null
    for (const home of candidateHomes()) {
      const file = join(home, 'storages', 'workspace.json')
      if (!existsSync(file)) continue
      try {
        const unit = JSON.parse(readFileSync(file, 'utf8'))
        const ids = unit && unit.global && unit.global.archivedSessionIds
        if (Array.isArray(ids)) {
          if (ids.length === 0) {
            // A different DSH_HOME can contain an empty workspace.json. Keep
            // looking: the real profile may be the next candidate.
            if (empty === null) empty = { file, ids }
            continue
          }
          if (storageRoot !== file) {
            storageRoot = file
            console.info('[dsh-toolbox] archived ids read from ' + file + ' (' + ids.length + ')')
          }
          return ids
        }
      } catch (error) {
        console.warn('[dsh-toolbox] reading ' + file + ' failed: ' + (error && error.message))
      }
    }
    if (empty !== null) {
      if (storageRoot !== empty.file) {
        storageRoot = empty.file
        console.info('[dsh-toolbox] archived ids read from ' + empty.file + ' (0)')
      }
      return empty.ids
    }
    return []
  }

  const isLive = (id) => {
    try {
      if (!sessions || typeof sessions.get !== 'function') return true // unknown => refuse
      return sessions.get(id) !== undefined
    } catch (error) {
      return true
    }
  }

  let probe = null
  const rootFor = sessionsRoot ?? (typeof sessionsRootFor === 'function' ? sessionsRootFor(dshHome()) : join(dshHome(), 'sessions'))
  probe = createFsProbe({ sessionsRoot: rootFor })

  return {
    /** Pure diagnostics: what the registry actually looks like at runtime. */
    shape() {
      const describe = (value) => {
        const type = typeof value
        let length = null
        let keys = null
        try {
          if (value && (Array.isArray(value) || value instanceof Set || typeof value[Symbol.iterator] === 'function')) length = [...value].length
          else if (typeof value === 'object' && value !== null) keys = Object.keys(value).slice(0, 25)
        } catch (error) {
          length = 'threw'
        }
        return { type, length, keys }
      }
      return {
        registryKeys: Object.keys(registry || {}).slice(0, 40),
        archivedSessionIds: describe(registry && registry.archivedSessionIds),
        list: describe(registry && registry.list),
        unarchiveSession: typeof (registry && registry.unarchiveSession),
      }
    },
    readArchived,
    isLive,
    probe,
    unarchive: (id) => {
      if (!canUnarchive) throw new Error('workspaceRegistry unavailable: unarchive is disabled')
      return registry.unarchiveSession(id)
    },
    /** Read-only mode: the list works, unarchive does not. */
    readOnly: !canUnarchive,
    // The old panel dropped workspace rows and scrubbed a projection cache. Both
    // are best-effort; the delete is already durable when they run.
    /**
     * 把这条会话从 workspace 的成员列表里摘掉（await entity.mutate）。
     *
     * 侧栏的会话行来自这里，不是来自目录——目录搬走了、行还在，用户就会看到
     * 「删了但还挂在未分组下面」。旧插件实现过，这里是照搬。
     */
    async dropWorkspaceRows(id, seat) {
      // 没有 registry 时确实无法摘行，但也不能把删除卡在 trashed：
      // 没有工作区服务 = 没有行可摘，按「本来就干净」处理。
      if (!hasRegistry || typeof registry.list !== 'function') return { ok: true, dropped: 0, already: true, reason: 'no-registry' }
      const drop = canonicalSessionId(String(id))
      // 快照优先：移动之后 entity.sessionIds 是 filtered getter，目录不在了它既可能
      // 返回空、也可能直接抛；seat 是删除前记下的，永远有效。
      const targetWorkspace = seat && seat.workspaceId ? String(seat.workspaceId) : null
      let entities
      try {
        entities = registry.list()
      } catch (error) {
        console.error('[dsh-toolbox] dropWorkspaceRows: registry.list() 失败 id=' + id, error)
        return { ok: false, reason: 'list-failed' }
      }

      /** 读取某个工作区当前的成员：原始记录优先，filtered getter 兜底且可能抛。 */
      const readIds = (entity) => {
        if (Array.isArray(entity.record?.sessionIds)) return entity.record.sessionIds
        try {
          return Array.isArray(entity.sessionIds) ? entity.sessionIds : []
        } catch (error) {
          return []
        }
      }

      let dropped = 0
      let already = false
      console.info(
        '[dsh-toolbox] dropWorkspaceRows: entities=' +
          (Array.isArray(entities) ? entities.length : typeof entities) +
          ' target=' + (targetWorkspace === null ? '(by id)' : targetWorkspace),
      )

      for (const entity of entities ?? []) {
        // 官方写路径是 detachSession（mutate 是 private）。不能再拿 mutate 当入场券：
        // 那样会把「有公开方法、没有私有方法」的实体整个跳过，等于什么都没做。
        if (!entity) continue
        if (typeof entity.detachSession !== 'function' && typeof entity.mutate !== 'function') continue
        const entityKey = String(entity.id ?? entity.workspaceId ?? '')
        if (targetWorkspace !== null && entityKey !== targetWorkspace) continue
        const ids = readIds(entity)
        const matched = targetWorkspace !== null || ids.some((row) => canonicalSessionId(String(row)) === drop)
        if (!matched) continue

        // P0-2：一律用快照里记下的**真实拼写**。直接用请求 id 会踩 bare / session-
        // 前缀不一致：detachSession 是精确匹配，幂等返回、一行没删，却报 dropped=1。
        const realId =
          seat && seat.sessionId ? String(seat.sessionId) : ids.find((row) => canonicalSessionId(String(row)) === drop)
        if (realId === undefined) {
          // 匹配到工作区、但这一行本来就不在：这是「已经干净」，不算失败。
          already = true
          continue
        }

        const before = ids.length
        try {
          await entity.detachSession(String(realId))
        } catch (error) {
          console.error('[dsh-toolbox] detachSession 失败，退回写记录 entity=' + entityKey + ' id=' + realId, error)
          try {
            await entity.mutate((record) => ({
              ...record,
              sessionIds: (record.sessionIds ?? []).filter((row) => canonicalSessionId(String(row)) !== drop),
            }))
          } catch (inner) {
            console.error('[dsh-toolbox] dropWorkspaceRows: 写记录也失败 entity=' + entityKey + ' id=' + realId, inner)
            return { ok: false, reason: 'detach-failed' }
          }
        }

        // P0-2 的核对：不再拿「方法没抛」当成功，重新 list 一遍看它到底走没走。
        let after = []
        try {
          const fresh = registry.list()
          const freshEntity = (fresh ?? []).find((one) => String(one.id ?? one.workspaceId ?? '') === entityKey)
          after = freshEntity ? readIds(freshEntity) : []
        } catch (error) {
          after = []
        }
        if (after.some((row) => canonicalSessionId(String(row)) === drop)) {
          console.error(
            '[dsh-toolbox] dropWorkspaceRows: detach 之后仍在 entity=' + entityKey + ' id=' + realId +
              ' before=' + before + ' after=' + after.length,
          )
          return { ok: false, reason: 'detach-no-effect' }
        }
        dropped += 1
        console.info('[dsh-toolbox] detachSession ok entity=' + entityKey + ' id=' + realId + ' (' + before + '→' + after.length + ')')
      }

      // 没有快照、而且没有任何工作区包含这一行：这就是「未分组」会话。
      // 它本来就不在 workspace 里，没有行可摘 = 本来就干净，绝不能判成失败
      // （以前这里返回 not-found，cleanup 停在 trashed，侧栏那条永远不消失）。
      if (dropped === 0 && !already && targetWorkspace === null) {
        return { ok: true, dropped: 0, already: true, reason: 'ungrouped' }
      }

      if (dropped === 0 && !already) {
        // 有 seat 却一行没摘，或压根没定位到：这就是「报成功但没删」的老毛病，必须失败。
        console.error(
          '[dsh-toolbox] dropWorkspaceRows: 没摘到任何行 id=' + id + ' target=' + (targetWorkspace ?? '(by id)'),
        )
        return { ok: false, reason: targetWorkspace === null ? 'not-found' : 'workspace-row-missing' }
      }
      console.info('[dsh-toolbox] dropWorkspaceRows: id=' + id + ' dropped=' + dropped + ' already=' + already)
      return { ok: true, dropped, already }
    },

    /**
     * 清理 projection cache（session_projcache.json 的 tables.sessions + 每会话文件）。
     * 两种拼写都删。
     */
    scrubCache(id) {
      const home = dshHome()
      const spellings = [String(id), String(id).replace(/^session-/, '')]
      let touched = 0
      try {
        const indexPath = join(home, 'storages', 'session_projcache.json')
        if (existsSync(indexPath)) {
          const parsed = JSON.parse(readFileSync(indexPath, 'utf8'))
          const sessions = parsed && parsed.tables && parsed.tables.sessions
          if (sessions && typeof sessions === 'object') {
            let changed = false
            for (const key of spellings) {
              if (Object.prototype.hasOwnProperty.call(sessions, key)) {
                delete sessions[key]
                changed = true
                touched += 1
              }
            }
            if (changed) writeFileSync(indexPath, JSON.stringify(parsed, null, 2), 'utf8')
          }
        }
      } catch (error) {
        /* 索引坏了就交给宿主，别在删除路径上炸 */
      }
      const perSessionDir = join(home, 'storages', 'session_projcache', 'sessions')
      const failures = []
      for (const key of spellings) {
        try {
          const file = join(perSessionDir, key + '.json')
          if (existsSync(file)) {
            unlinkSync(file)
            touched += 1
          }
        } catch (error) {
          // Windows 上文件被占用（EBUSY/EPERM）会走到这里：不能当成功。
          failures.push(key + ':' + String((error && error.code) || error))
        }
      }
      if (failures.length > 0) console.warn('[dsh-toolbox] scrubCache 未删净: ' + failures.join(', '))
      return { ok: failures.length === 0, touched, failed: failures }
    },

    /**
     * 删除前记下这条会话在工作区里的身份，恢复时才能放回原位。
     * @returns {{workspaceId: string, sessionId: string, beforeSessionId: (string|null)}|null}
     */
    snapshotWorkspace(id) {
      if (!hasRegistry || typeof registry.list !== 'function') return null
      const target = canonicalSessionId(String(id))
      let entities
      try {
        entities = registry.list()
      } catch (error) {
        console.error('[dsh-toolbox] snapshotWorkspace: registry.list() 失败 id=' + id, error)
        return null
      }
      for (const entity of entities ?? []) {
        // 归档会话的目录已经不在原位，entity.sessionIds 这个 filtered getter 在
        // 访问时可能直接抛——而这一步发生在删除之前，一抛整个 delete 就 500。
        // 原始记录优先，getter 只作兜底且包起来。
        let ids = Array.isArray(entity.record?.sessionIds) ? entity.record.sessionIds : null
        if (ids === null) {
          try {
            ids = Array.isArray(entity.sessionIds) ? entity.sessionIds : []
          } catch (error) {
            console.error('[dsh-toolbox] snapshotWorkspace: 读取 sessionIds 抛错 id=' + id, error)
            ids = []
          }
        }
        const index = ids.findIndex((value) => canonicalSessionId(String(value)) === target)
        if (index < 0) continue
        return {
          workspaceId: String(entity.id ?? entity.workspaceId ?? ''),
          sessionId: String(ids[index]),
          beforeSessionId: index + 1 < ids.length ? String(ids[index + 1]) : null,
        }
      }
      return null
    },

    /**
     * 恢复时按快照把会话放回原来的工作区与位置。
     */
    async reattach(snapshot) {
      if (!snapshot || !hasRegistry || typeof registry.list !== 'function') return { ok: false, reason: 'no-snapshot' }
      const target = canonicalSessionId(String(snapshot.sessionId || ''))
      let entities
      try {
        entities = registry.list()
      } catch (error) {
        console.error('[dsh-toolbox] reattach: registry.list() 失败', error)
        return { ok: false, reason: 'list-failed' }
      }
      for (const entity of entities ?? []) {
        if (!entity) continue
        const canInsert = typeof entity.insertSessionBefore === 'function'
        const canAttach = typeof entity.attachSession === 'function'
        const canMutate = typeof entity.mutate === 'function'
        if (!canInsert && !canAttach && !canMutate) continue
        if (String(entity.id ?? entity.workspaceId ?? '') !== snapshot.workspaceId) continue

        // 顺序必须是「先挂载、再定位」。insertSessionBefore 要求会话已经在 record
        // 里，而删除时已经 detach 过 —— 先 insert 必然报 not accounted，最后只能
        // 落到追加，会话就永远回不到原位（终审 P1-1 实测到的就是这个）。
        const before = snapshot.beforeSessionId ? String(snapshot.beforeSessionId) : null
        const sessionId = String(snapshot.sessionId)

        if (canAttach) {
          try {
            await entity.attachSession(sessionId)
          } catch (error) {
            console.error('[dsh-toolbox] reattach: attachSession 失败，退回写记录', error)
            return fallbackMutate(entity, before, sessionId, target)
          }
          // 挂上了，再调位置；调不动也已经挂回去了，位置只是次优。
          if (canInsert && before !== null) {
            try {
              await entity.insertSessionBefore(sessionId, before)
              return { ok: true, mode: 'attach+insertBefore' }
            } catch (error) {
              console.error('[dsh-toolbox] reattach: 已挂载但调整位置失败（保留追加位置）', error)
            }
          }
          return { ok: true, mode: 'attach' }
        }

        return fallbackMutate(entity, before, sessionId, target)
      }
      // 「未分组」的会话不属于任何工作区实体：没有行可摘 = 本来就干净。
      // 以前这里返回失败，导致 cleanup 停在 trashed、侧栏那条永远不消失。
      return { ok: true, dropped: 0, already: true }
    },
  }
}

/** 没有 attachSession 的老实现：直接改记录，按 before 插入或追加。 */
function fallbackMutate(entity, before, sessionId, target) {
  try {
    return entity
      .mutate((record) => {
        const ids = Array.isArray(record.sessionIds) ? record.sessionIds.slice() : []
        if (ids.some((value) => canonicalSessionId(String(value)) === target)) return record
        const anchor = before
          ? ids.findIndex((value) => canonicalSessionId(String(value)) === canonicalSessionId(before))
          : -1
        if (anchor >= 0) ids.splice(anchor, 0, sessionId)
        else ids.push(sessionId)
        return { ...record, sessionIds: ids }
      })
      .then(() => ({ ok: true, mode: 'mutate' }))
      .catch((error) => {
        console.error('[dsh-toolbox] reattach: 写记录失败', error)
        return { ok: false, reason: 'mutate-failed' }
      })
  } catch (error) {
    console.error('[dsh-toolbox] reattach: 写记录失败', error)
    return { ok: false, reason: 'mutate-failed' }
  }
}

/** Is this adapter good enough to mount the HTTP API? */
export function adapterIsUsable(adapter) {
  return Boolean(
    adapter &&
      typeof adapter.readArchived === 'function' &&
      typeof adapter.isLive === 'function' &&
      typeof adapter.probe === 'function',
  )
}
