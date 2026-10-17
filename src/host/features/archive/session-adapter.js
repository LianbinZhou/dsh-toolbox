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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  if (!registry || typeof registry !== 'object') return null
  if (typeof registry.unarchiveSession !== 'function') return null

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
      ids = registry.archivedSessionIds
      if (typeof ids === 'function') ids = ids.call(registry)
      if (ids && typeof ids.getSnapshot === 'function') ids = ids.getSnapshot()
      else if (ids && typeof ids.get === 'function') ids = ids.get()
      else if (ids && typeof ids.current === 'function') ids = ids.current()
    } catch (error) {
      console.warn('[dsh-toolbox] reading archivedSessionIds failed', error)
      return []
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

  /** The persisted archive set, used only when the registry seam answers empty. */
  function readArchivedFromStorage() {
    try {
      const file = join(dshHome(), 'storages', 'workspace.json')
      const unit = JSON.parse(readFileSync(file, 'utf8'))
      const ids = unit && unit.global && unit.global.archivedSessionIds
      return Array.isArray(ids) ? ids : []
    } catch (error) {
      return []
    }
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
    unarchive: (id) => registry.unarchiveSession(id),
    // The old panel dropped workspace rows and scrubbed a projection cache. Both
    // are best-effort; the delete is already durable when they run.
    dropWorkspaceRows: () => {},
    scrubCache: () => {},
  }
}

/** Is this adapter good enough to mount the HTTP API? */
export function adapterIsUsable(adapter) {
  return Boolean(
    adapter &&
      typeof adapter.readArchived === 'function' &&
      typeof adapter.isLive === 'function' &&
      typeof adapter.probe === 'function' &&
      typeof adapter.unarchive === 'function',
  )
}
