/**
 * S4-b · the REAL filesystem probe (Pi D1 / R5-5 / R5-14).
 *
 * The service's tri-state contract was only ever exercised through a test stub.
 * This module is the production implementation, and it is where "the file is not
 * there" must never be confused with "I was not allowed to look":
 *
 *   { state: 'present', dir, identity:{dev,ino,realpath} }
 *   { state: 'absent' }            // confirmed: the session directory is not there
 *   { state: 'unsafe', reason }    // a link, or a path that resolves outside
 *   { state: 'error', error }      // unreadable root, permission error, ENOTDIR
 *
 * The dangerous collapse is `absent`. Only a COMPLETE, error-free walk of the
 * sessions root may produce it; if any project could not be read, the honest
 * answer is `error` (refuse), because the session might be inside the directory
 * we were not allowed to open.
 */

import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { isInside, isSafeSessionId } from './paths.js'

/**
 * @param {object} options
 * @param {string} options.sessionsRoot - absolute `<home>/sessions`
 * @returns {(id: string) => object} the tri-state probe
 */
export function createFsProbe({ sessionsRoot }) {
  return function probe(id) {
    if (!isSafeSessionId(id)) return { state: 'unsafe', reason: 'invalid-id' }

    let rootReal
    try {
      rootReal = realpathSync(sessionsRoot)
    } catch (error) {
      // The sessions root itself is unavailable: that is NOT "every session is
      // already deleted".
      return { state: 'error', error }
    }

    let projects
    try {
      projects = readdirSync(sessionsRoot)
    } catch (error) {
      return { state: 'error', error }
    }

    const wanted = new Set([id, id.replace(/^session-/, '')])
    let sawUnreadable = null

    for (const project of projects) {
      const projectPath = join(sessionsRoot, project)

      // R5-5: a project directory that is a link could point anywhere.
      try {
        if (lstatSync(projectPath).isSymbolicLink()) continue
      } catch (error) {
        sawUnreadable = error
        continue
      }

      let segments
      try {
        segments = readdirSync(projectPath)
      } catch (error) {
        // Remember it: an unreadable project may be hiding our session.
        sawUnreadable = error
        continue
      }

      for (const segment of segments) {
        if (!wanted.has(segment)) continue
        const dirPath = join(projectPath, segment)

        let stat
        try {
          stat = lstatSync(dirPath)
        } catch (error) {
          return { state: 'error', error }
        }
        // R2: a link is never a session, even when it resolves inside the root.
        if (stat.isSymbolicLink()) return { state: 'unsafe', reason: 'link' }
        if (!stat.isDirectory()) continue

        let real
        try {
          real = realpathSync(dirPath)
        } catch (error) {
          return { state: 'error', error }
        }
        if (!isInside(rootReal, real)) return { state: 'unsafe', reason: 'outside-root' }

        return {
          state: 'present',
          dir: dirPath,
          identity: { dev: stat.dev, ino: stat.ino, realpath: real },
        }
      }
    }

    // No match. Only now may we say "absent" — and only if nothing was unreadable.
    if (sawUnreadable !== null) return { state: 'error', error: sawUnreadable }
    return { state: 'absent' }
  }
}
