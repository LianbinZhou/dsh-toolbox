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
export function createSessionAdapter({ registry, sessions, sessionsRoot } = {}) {
  if (!registry || typeof registry !== 'object') return null
  if (typeof registry.unarchiveSession !== 'function') return null

  const readArchived = () => {
    const ids = registry.archivedSessionIds
    if (ids === undefined || ids === null) return []
    return Array.from(ids).map(String)
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
