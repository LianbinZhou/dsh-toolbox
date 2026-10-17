/**
 * S4-b · the PRE-migration archive delete algorithm, reproduced faithfully.
 *
 * Copied from `dsh-plugins/dsh-archive-manager/src/host/index.js`
 * (`ArchiveManagerService.delete`, pre-S4-b), reduced to its algorithm and given
 * injectable dependencies so each failure point can be driven from a test.
 *
 * Every flaw Pi's R4/R5 list names is annotated. This is the defendant: the
 * matrix must be RED here.
 */

const DRAFT_PREFIX = 'dsh.conversation.'

/**
 * @param {object} deps
 * @param {() => string[]} deps.readArchived - durable archived ids
 * @param {(id: string) => boolean} deps.isLive - a running session
 * @param {(id: string) => (string|undefined)} deps.findDir
 * @param {(dir: string) => void} deps.removeDir
 * @param {(id: string) => void} deps.unarchive
 * @param {(id: string) => void} deps.dropWorkspaceRows
 * @param {(id: string) => void} deps.scrubCache
 * @param {(step: string, id: string) => (Promise<void>|void)} [deps.beforeStep]
 */
export function createLegacyArchiveService(deps) {
  const beforeStep = deps.beforeStep || (() => {})

  return {
    async delete(id) {
      // FLAW R4-1/R4-3: no live check, ever.
      const archived = deps.readArchived()
      if (!archived.some((entry) => String(entry) === String(id))) {
        return { ok: false, error: 'not archived' }
      }

      const dir = deps.findDir(id)
      if (dir === undefined) {
        // FLAW R5-1: this is a dead end. The archive marker stays forever because
        // there is no directory left to justify a delete.
        return { ok: false, error: 'session directory not found' }
      }

      await beforeStep('rm', id)
      // FLAW R4-2: the archived set is never re-read here, so an unarchive that
      // happened after the check is silently ignored.
      try {
        deps.removeDir(dir)
      } catch (error) {
        return { ok: false, error: 'remove failed' }
      }

      // FLAW R5-1/R5-2: bookkeeping runs AFTER the file is gone and failures only
      // become a warning, so a partial failure is unrecoverable through this API.
      const warnings = []
      try {
        deps.unarchive(id)
      } catch (error) {
        warnings.push('unarchive failed')
      }
      try {
        deps.dropWorkspaceRows(id)
      } catch (error) {
        warnings.push('workspace failed')
      }
      try {
        deps.scrubCache(id)
      } catch (error) {
        warnings.push('cache failed')
      }

      return warnings.length === 0
        ? { ok: true, removedDir: true }
        : { ok: true, removedDir: true, warning: warnings.join('; ') }
    },

    /** The legacy list: whatever the in-memory snapshot says. */
    async list() {
      return { ok: true, rows: deps.readArchived().map((id) => ({ id: String(id) })) }
    },
  }
}

export { DRAFT_PREFIX }
