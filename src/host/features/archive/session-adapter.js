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
import { dshHome, sessionsRootFor } from './paths.js'
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
    async dropWorkspaceRows(id) {
      if (!hasRegistry || typeof registry.list !== 'function') return { ok: false, reason: 'no-registry' }
      const drop = canonicalSessionId(String(id))
      let entities
      try {
        entities = registry.list()
      } catch (error) {
        return { ok: false, reason: 'list-failed' }
      }
      let dropped = 0
      for (const entity of entities ?? []) {
        if (!entity || typeof entity.mutate !== 'function') continue
        const ids = Array.isArray(entity.sessionIds) ? entity.sessionIds : []
        if (!ids.some((value) => canonicalSessionId(String(value)) === drop)) continue
        try {
          await entity.mutate((record) => ({
            ...record,
            sessionIds: (record.sessionIds ?? []).filter((value) => canonicalSessionId(String(value)) !== drop),
          }))
          dropped += 1
        } catch (error) {
          /* 行是展示层：存储已经没了，这里失败不该让删除回滚 */
        }
      }
      return { ok: true, dropped }
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
      for (const key of spellings) {
        try {
          const file = join(perSessionDir, key + '.json')
          if (existsSync(file)) {
            unlinkSync(file)
            touched += 1
          }
        } catch (error) {
          /* 同上 */
        }
      }
      return { ok: true, touched }
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
        return null
      }
      for (const entity of entities ?? []) {
        if (!entity || !Array.isArray(entity.sessionIds)) continue
        const index = entity.sessionIds.findIndex((value) => canonicalSessionId(String(value)) === target)
        if (index < 0) continue
        return {
          workspaceId: String(entity.id ?? entity.workspaceId ?? ''),
          sessionId: String(entity.sessionIds[index]),
          beforeSessionId: index + 1 < entity.sessionIds.length ? String(entity.sessionIds[index + 1]) : null,
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
        return { ok: false, reason: 'list-failed' }
      }
      for (const entity of entities ?? []) {
        if (!entity || typeof entity.mutate !== 'function') continue
        if (String(entity.id ?? entity.workspaceId ?? '') !== snapshot.workspaceId) continue
        try {
          await entity.mutate((record) => {
            const ids = Array.isArray(record.sessionIds) ? record.sessionIds.slice() : []
            if (ids.some((value) => canonicalSessionId(String(value)) === target)) return record
            const anchor = snapshot.beforeSessionId
              ? ids.findIndex((value) => canonicalSessionId(String(value)) === canonicalSessionId(String(snapshot.beforeSessionId)))
              : -1
            if (anchor >= 0) ids.splice(anchor, 0, snapshot.sessionId)
            else ids.push(snapshot.sessionId)
            return { ...record, sessionIds: ids }
          })
          return { ok: true }
        } catch (error) {
          return { ok: false, reason: 'mutate-failed' }
        }
      }
      return { ok: false, reason: 'workspace-not-found' }
    },
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
