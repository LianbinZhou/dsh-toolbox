/**
 * S4-c · real dependencies for the archive service.
 *
 * `createArchiveService` needs a journal, a trash root and a dozen callbacks. This
 * module supplies the FILE-SYSTEM half (journal, trash, nonce, volume check,
 * remove) from one directory under `$DSH_HOME/storages`, and takes the SESSION
 * half as an injected adapter, because which service owns the archived set is a
 * host concern.
 *
 * Rules encoded here:
 *
 *  - everything lives under one root, on one volume (a cross-volume rename is a
 *    copy, and a copy is not atomic);
 *  - a corrupt journal fails closed before anything is moved;
 *  - removal goes through `removeTrashTree`, the hardened walk (top-level links
 *    are refused).
 */

import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createFileJournal } from './journal.js'
import { removeTrashTree } from './trash-gc.js'
import { createFileAudit } from './audit.js'
import { createArchiveService } from './service.js'
import { isInside } from './paths.js'

/**
 * @param {object} options
 * @param {string} options.home - `$DSH_HOME/storages` or a test directory
 * @param {object} options.adapter - { readArchived, isLive, probe, unarchive, dropWorkspaceRows, scrubCache }
 */
export function createServiceDeps({ home, adapter, maxProtected = 200, ttlDays = 7 } = {}) {
  if (typeof home !== 'string' || home.length === 0) throw new TypeError('createServiceDeps needs a home directory')
  if (!adapter || typeof adapter.readArchived !== 'function') throw new TypeError('createServiceDeps needs a session adapter')

  const sessionsRoot = join(home, '..', 'sessions')
  const base = join(home, 'archive')
  const trash = join(base, 'trash')
  // The volume check stats both paths, so both must exist before the first delete.
  mkdirSync(trash, { recursive: true })
  const journal = createFileJournal(base)
  const audit = createFileAudit(join(base, 'audit.jsonl'), { maxBytes: 256 * 1024 })

  /** 垃圾箱保留天数：到期才由清理器物理清空。 */
  const trashKeptDays = Number.isFinite(ttlDays) ? ttlDays : 7

  return {
    trashKeptDays,
    readArchived: () => adapter.readArchived().map(String),
    isLive: (id) => adapter.isLive(id) === true,
    probe: (id) => adapter.probe(id),
    unarchive: (id) => adapter.unarchive(id),
    dropWorkspaceRows: (id) => adapter.dropWorkspaceRows?.(id),
    scrubCache: (id) => adapter.scrubCache?.(id),
    trashRoot: () => trash,
    /** 会话目录是否仍在 sessions 根内（真实路径边界，不是前缀比较）。 */
    isInsideSessions: (candidate) => isInside(sessionsRoot, candidate),
    /** 垃圾箱路径是否仍在 trash 根内。 */
    isInsideTrash: (candidate) => isInside(trash, candidate),
    sameVolume(a, b) {
      try {
        const left = statSync(a, { throwIfNoEntry: false })
        const right = statSync(b, { throwIfNoEntry: false })
        if (!left || !right) return false
        return String(left.dev) === String(right.dev)
      } catch (error) {
        return false
      }
    },
    renamePath(from, to) {
      mkdirSync(trash, { recursive: true })
      renameSync(from, to)
    },
    removeTree: (dir) => removeTrashTree(dir, trash),
    journal,
    audit,
    maxProtected,
    nonce: () => randomBytes(16).toString('hex'),
    exists: (path) => existsSync(path),
    shape: () => (adapter && typeof adapter.shape === 'function' ? adapter.shape() : undefined),
  }
}

/**
 * Build the service and the small `api` surface the HTTP routes call.
 * @returns {{ service: object, api: { list: Function, unarchive: Function, delete: Function } }}
 */
export function createArchiveApi(options) {
  const deps = createServiceDeps(options)
  const service = createArchiveService(deps)
  return {
    service,
    deps,
    api: {
      list: () => service.list(),
      trash: () => service.listTrash(),
      restore: (id) => service.restore(id),
      purge: (id) => service.purge(id),
      debug: () => (typeof deps.shape === 'function' ? deps.shape() : { reason: 'no shape()' }),
      unarchive: async (id) => {
        const result = await service.unarchiveSession(id)
        return { ok: result?.ok !== false }
      },
      delete: (id) => service.delete(id),
    },
  }
}
