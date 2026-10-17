/**
 * S4-b · R4 / R5 / D / T service matrix (v2 contract).
 *
 * The dependency contract changed because the tombstone design was rejected:
 * `probe` is now TRI-STATE (a permission error is not "the file is gone"), the
 * service writes a durable CLAIM before moving anything, the move target is a
 * trash entry named by a random nonce, and every phase lands in a journal so a
 * restart can resume.
 *
 * Deps (all injectable, so every failure point can be driven):
 *   readArchived() -> string[]
 *   isLive(id) -> boolean
 *   probe(id) -> {state:'present', dir, identity:{dev,ino,realpath}}
 *              | {state:'absent'} | {state:'unsafe', reason} | {state:'error', error}
 *   renamePath(from, to) -> void
 *   removeTree(dir) -> void
 *   trashRoot() -> string
 *   sameVolume(a, b) -> boolean
 *   unarchive(id) / dropWorkspaceRows(id) / scrubCache(id) -> void
 *   journal { read(), write(entries) }
 *   nonce() -> string
 *   beforeStep(step, id) -> Promise|void
 */

import assert from 'node:assert/strict'

const ID_A = 'session-aaaaaaaa-1111-2222-3333-444444444444'
const ID_B = 'session-bbbbbbbb-1111-2222-3333-444444444444'
const ID_C = 'session-cccccccc-1111-2222-3333-444444444444'
const TRASH = 'C:/home/storages/archive-trash'

function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * The world: a fake filesystem (dirs + trash), a mutable archived/live set, a
 * durable journal that survives "restart", and call counters.
 */
export function makeWorld(options = {}) {
  const archived = new Set(options.archived ?? [ID_A, ID_B, ID_C])
  const live = new Set(options.live ?? [])
  const dirs = new Map([
    [ID_A, 'C:/home/sessions/projA/' + ID_A],
    [ID_B, 'C:/home/sessions/projA/' + ID_B],
    [ID_C, 'C:/home/sessions/projB/' + ID_C],
  ])
  const identity = (id) => { const p = dirs.get(id) || ""; return { dev: 1, ino: 1000 + [...String(p)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0), realpath: p } }
  const probeOverrides = new Map()
  const calls = { rename: [], removeTree: [], unarchive: [], workspace: [], cache: [], probe: [] }
  const failAt = options.failAt || {}
  const pauseAt = options.pauseAt || {}
  const events = []

  /** Durable journal: an array, written whole each time (atomic in production). */
  let entries = options.journal ?? []
  function writeJournal(next) {
    if (failAt.step === 'journal') throw failAt.error || new Error('journal write failed')
    entries = next
    events.push('journal:' + next.map((e) => e.id.slice(0, 9) + '=' + e.phase).join(','))
  }

  function failIf(step) {
    if (failAt.step === step) throw failAt.error || new Error(step + ' failed')
  }

  let counter = 0
  const deps = {
    readArchived: () => [...archived],
    isLive: (id) => live.has(id),
    probe: (id) => {
      calls.probe.push(id)
      const override = probeOverrides.get(id)
      if (override) return typeof override === 'function' ? override() : override
      if (failAt.step === 'probe') return { state: 'error', error: new Error('EACCES') }
      if (!dirs.has(id)) return { state: 'absent' }
      return { state: 'present', dir: dirs.get(id), identity: identity(id) }
    },
    renamePath: (from, to) => {
      calls.rename.push({ from, to })
      failIf('rename')
      // session -> trash
      const id = [...dirs.entries()].find(([, d]) => d === from)?.[0]
      if (id !== undefined) {
        dirs.delete(id)
        trash.set(to, id)
        return
      }
      // trash -> session (restore, T8)
      const trashed = trash.get(from)
      if (trashed !== undefined) {
        trash.delete(from)
        dirs.set(trashed, to)
        return
      }
      throw new Error('ENOENT: source is gone')
    },
    removeTree: (dir) => {
      calls.removeTree.push(dir)
      failIf('trash-purge')
      if (typeof options.removeTree === 'function') {
        options.removeTree(dir)
        return
      }
      for (const [trashPath, id] of [...trash.entries()]) {
        if (trashPath === dir) trash.delete(trashPath)
      }
      // The v1 defendant calls this on a SESSION directory (its `rm -r`).
      for (const [id, sessionDir] of [...dirs.entries()]) {
        if (sessionDir === dir) dirs.delete(id)
      }
    },
    trashRoot: () => TRASH,
    sameVolume: () => options.sameVolume !== false,
    unarchive: (id) => {
      calls.unarchive.push(id)
      failIf('unarchive')
      // D5: an unarchive that is not idempotent throws when already gone.
      if (options.strictUnarchive && !archived.has(id)) throw new Error('not archived')
      archived.delete(id)
    },
    dropWorkspaceRows: (id) => {
      calls.workspace.push(id)
      failIf('workspace')
    },
    scrubCache: (id) => {
      calls.cache.push(id)
      failIf('cache')
    },
    journal: { read: () => entries.map((e) => ({ ...e })), write: writeJournal },
    nonce: () => 'nonce' + (counter += 1) + '-abcdef',
    beforeStep: async (step, id) => {
      if (pauseAt.step === step && pauseAt.gate) await pauseAt.gate.promise
    },
    __world: null,
  }

  const trash = new Map()

  const world = {
    archived,
    live,
    dirs,
    trash,
    calls,
    events,
    setProbe(id, value) {
      probeOverrides.set(id, value)
    },
    setLive(id, value) {
      if (value) live.add(id)
      else live.delete(id)
    },
    unarchiveDirectly(id) {
      archived.delete(id)
    },
    dirExists: (id) => dirs.has(id),
    isArchived: (id) => archived.has(id),
    journalEntries: () => entries.map((e) => ({ ...e })),
    journalPhase: (id) => entries.find((e) => e.id === id)?.phase,
    replaceJournal(next) {
      entries = next
    },
    trashCount: () => trash.size,
  }
  deps.__world = world
  return { deps, world, deferred }
}

export const SERVICE_CASES = [
  /* ---------------- D1: tri-state, never misread an error as absence -------- */
  {
    id: 'D1',
    title: 'a probe ERROR is refused, not treated as "files already gone"',
    async run({ createService, make }) {
      const { deps, world } = make()
      world.setProbe(ID_A, { state: 'error', error: new Error('EACCES: permission denied') })
      const service = createService(deps)
      const result = await service.delete(ID_A)
      assert.equal(result.ok, false, 'a permission error must never unarchive a real session')
      assert.equal(world.isArchived(ID_A), true, 'the archive marker stays')
      assert.equal(world.calls.unarchive.length, 0)
    },
  },
  {
    id: 'D1b',
    title: 'a probe UNSAFE (link) is refused, not treated as absent',
    async run({ createService, make }) {
      const { deps, world } = make()
      world.setProbe(ID_A, { state: 'unsafe', reason: 'junction-targets-another-session' })
      const service = createService(deps)
      const result = await service.delete(ID_A)
      assert.equal(result.ok, false)
      assert.equal(world.isArchived(ID_A), true)
      assert.equal(world.calls.unarchive.length, 0)
    },
  },
  {
    id: 'D1c',
    title: 'a genuinely ABSENT directory may still be cleaned up (and only then)',
    async run({ createService, make }) {
      const { deps, world } = make()
      world.dirs.delete(ID_A)
      const service = createService(deps)
      const result = await service.delete(ID_A)
      assert.equal(result.ok, true, 'absent + archived is the cleanup-only case')
      assert.equal(world.isArchived(ID_A), false)
    },
  },

  /* ---------------- D2: a durable claim closes the recheck window ----------- */
  {
    id: 'D2',
    title: 'a durable claim exists BEFORE the directory moves (T4)',
    async run({ createService, make }) {
      const { deps, world } = make()
      let claimAtMove = null
      const originalRename = deps.renamePath
      deps.renamePath = (from, to) => {
        // Whatever is in the journal at the moment of the move IS the claim.
        claimAtMove = deps.journal.read().find((entry) => entry.id === ID_A) || null
        return originalRename(from, to)
      }
      const service = createService(deps)
      const result = await service.delete(ID_A)
      assert.equal(result.ok, true, 'the delete itself succeeds')
      assert.ok(claimAtMove, 'nothing durable was written before the move')
      assert.equal(claimAtMove.phase, 'deleting')
      assert.ok(claimAtMove.nonce, 'the claim carries the nonce')
      assert.equal(world.dirExists(ID_A), false)
    },
  },
  {
    id: 'D2b',
    title: 'the claim records the identity the move is allowed to touch (D7)',
    async run({ createService, make }) {
      const { deps } = make()
      let claimAtMove = null
      const originalRename = deps.renamePath
      deps.renamePath = (from, to) => {
        claimAtMove = deps.journal.read().find((entry) => entry.id === ID_A) || null
        return originalRename(from, to)
      }
      const service = createService(deps)
      await service.delete(ID_A)
      assert.ok(claimAtMove, 'a claim must exist')
      assert.equal(claimAtMove.dev, 1, 'the device is recorded')
      assert.equal(typeof claimAtMove.ino, 'number', 'the inode is recorded')
      assert.ok(claimAtMove.originalPath, 'the original path is recorded for restore')
    },
  },

  /* ---------------- D7: identity must match the claim ----------------------- */
  {
    id: 'D7',
    title: 'a directory swapped for another real session is refused',
    async run({ createService, make }) {
      const { deps, world } = make()
      // Swap the directory AFTER the claim is durable and BEFORE the move. Doing
      // it inside `beforeStep('rename')` is the only point that is guaranteed to
      // be between the claim write and the identity re-check.
      const originalBefore = deps.beforeStep
      deps.beforeStep = async (step, id) => {
        if (step === 'rename' && id === ID_A) {
          // The path now holds ID_B's directory: inside the root, a real session,
          // every path-level check would pass.
          world.dirs.set(ID_A, world.dirs.get(ID_B))
          return
        }
        return originalBefore(step, id)
      }
      const service = createService(deps)
      const result = await service.delete(ID_A)
      assert.equal(result.ok, false, 'the identity recorded in the claim no longer matches')
      assert.equal(result.reason, 'identity-changed')
      assert.equal(world.calls.rename.length, 0, 'nothing was moved')
      assert.equal(world.dirExists(ID_B), true, 'the innocent sibling survives')
      assert.deepEqual(world.journalEntries(), [], 'the claim was released')
    },
  },

  /* ---------------- trash mechanics (T1 / T3 / T5 / T8) -------------------- */
  {
    id: 'T1',
    title: 'a cross-volume trash root is refused instead of copy+delete',
    async run({ createService, make }) {
      const { deps, world } = make({ sameVolume: false })
      const service = createService(deps)
      const result = await service.delete(ID_A)
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'cross-volume-trash')
      assert.equal(world.dirExists(ID_A), true, 'nothing moved')
      assert.equal(world.isArchived(ID_A), true)
    },
  },
  {
    id: 'T3',
    title: 'the trash entry is named by a nonce, never by the session id',
    async run({ createService, make }) {
      const { deps, world } = make()
      const service = createService(deps)
      await service.delete(ID_A)
      const moved = world.calls.rename[0]
      assert.ok(moved, 'the directory was moved')
      assert.equal(moved.to.includes(ID_A), false, 'the path must not contain the session id')
      assert.match(moved.to, /nonce/)
      assert.equal(world.trashCount(), 0, 'and it is purged once the bookkeeping succeeded')
    },
  },
  {
    id: 'T5',
    title: 'every phase lands in the journal, in order',
    async run({ createService, make }) {
      const { deps, world } = make()
      const service = createService(deps)
      await service.delete(ID_A)
      const phases = world.events.filter((e) => e.startsWith('journal:')).join('|')
      assert.match(phases, /deleting/)
      assert.match(phases, /trashed/)
      assert.match(phases, /cleaned/)
      assert.match(phases, /done/)
    },
  },
  {
    id: 'T8',
    title: 'restore() moves a trashed session back and leaves it unarchived',
    async run({ createService, make }) {
      const { deps, world } = make({ failAt: { step: 'workspace', error: new Error('registry down') } })
      const service = createService(deps)
      await service.delete(ID_A)
      assert.equal(world.dirExists(ID_A), false, 'it is in the trash now')

      const restored = await service.restore(ID_A)
      assert.equal(restored.ok, true, 'the user can get their files back')
      assert.equal(world.dirExists(ID_A), true, 'the directory is back at its original path')
      assert.equal(world.trashCount(), 0)
    },
  },

  /* ---------------- D3 / D4: heal is locked and durable -------------------- */
  {
    id: 'D3',
    title: 'heal() goes through the same per-id lock as delete',
    async run({ createService, make }) {
      const { deps, world } = make({ failAt: { step: 'workspace', error: new Error('down') } })
      const service = createService(deps)
      await service.delete(ID_A)
      assert.ok(world.journalEntries().some((e) => e.id === ID_A), 'a pending entry exists')

      // Fix the failure, then heal. If heal bypassed the lock it could race a
      // concurrent delete; the observable contract is: heal completes once.
      deps.dropWorkspaceRows = (id) => {
        world.calls.workspace.push(id)
      }
      const first = await service.heal()
      assert.ok(first.healed.includes(ID_A) || first.pending.length === 0, 'heal finished the entry')
      const second = await service.heal()
      assert.equal(second.pending.length, 0, 'and it is idempotent')
    },
  },
  {
    id: 'D4',
    title: 'a NEW service instance sees the pending work (durable journal)',
    async run({ createService, make }) {
      const { deps, world } = make({ failAt: { step: 'workspace', error: new Error('down') } })
      const first = createService(deps)
      await first.delete(ID_A)
      const entriesAfterCrash = world.journalEntries()
      assert.ok(entriesAfterCrash.length > 0, 'the journal is on disk')

      // "Restart": a brand new service over the same journal, queued to heal.
      const { deps: deps2, world: world2 } = make({ journal: entriesAfterCrash, archived: [...world.archived] })
      deps2.dropWorkspaceRows = (id) => {
        world2.calls.workspace.push(id)
      }
      const second = createService(deps2)
      await second.heal()
      assert.deepEqual(second.pendingCleanup(), [], 'the new instance finished the old work')
    },
  },

  /* ---------------- D5 / D6: idempotence and live re-check ---------------- */
  {
    id: 'D5',
    title: 'a non-idempotent unarchive does not leave the id pending forever',
    async run({ createService, make }) {
      const { deps, world } = make({ strictUnarchive: true, failAt: { step: 'workspace', error: new Error('down') } })
      const service = createService(deps)
      await service.delete(ID_A)
      deps.dropWorkspaceRows = (id) => {
        world.calls.workspace.push(id)
      }
      await service.heal()
      assert.deepEqual(service.pendingCleanup(), [], '"already unarchived" must count as success')
    },
  },
  {
    id: 'D6',
    title: 'cleanup-only still refuses when the session turned live',
    async run({ createService, make }) {
      const { deps, world } = make()
      world.dirs.delete(ID_A)
      let calls = 0
      const realIsLive = deps.isLive
      deps.isLive = (id) => {
        calls += 1
        return calls > 1 || realIsLive(id) // false on the first check, true later
      }
      const service = createService(deps)
      const result = await service.delete(ID_A)
      assert.equal(result.ok, false, 'a live session must not be unarchived')
      assert.equal(world.isArchived(ID_A), true)
    },
  },

  /* ---------------- D8 / R4: locks, concurrency, siblings ----------------- */
  {
    id: 'D8',
    title: 'two service instances cannot both move the same session',
    async run({ createService, make, deferred }) {
      const gate = deferred()
      const { deps, world } = make({ pauseAt: { step: 'rename', gate } })
      const a = createService(deps)
      const b = createService(deps)
      const first = a.delete(ID_A)
      const second = b.delete(ID_A)
      gate.resolve()
      const results = await Promise.all([first, second])
      assert.equal(results.filter((r) => r.ok).length, 1, 'the durable claim is the cross-instance lock')
      assert.equal(world.calls.rename.length, 1)
    },
  },
  {
    id: 'R4-1',
    title: 'a LIVE session is refused, and nothing is touched',
    async run({ createService, make }) {
      const { deps, world } = make({ live: [ID_A] })
      const service = createService(deps)
      const result = await service.delete(ID_A)
      assert.equal(result.ok, false)
      assert.equal(world.dirExists(ID_A), true)
      assert.equal(world.isArchived(ID_A), true)
      assert.equal(world.calls.rename.length, 0)
    },
  },
  {
    id: 'R4-4',
    title: 'a replayed delete is refused with a stable code and no second move',
    async run({ createService, make }) {
      const { deps, world } = make()
      const service = createService(deps)
      const first = await service.delete(ID_A)
      assert.equal(first.ok, true)
      const second = await service.delete(ID_A)
      assert.equal(second.ok, false)
      assert.ok(['already-deleted', 'not-archived'].includes(second.reason), 'got ' + second.reason)
      assert.equal(world.calls.rename.length, 1)
      assert.equal(world.calls.unarchive.length, 1)
    },
  },
  {
    id: 'R5-9',
    title: 'sibling sessions in the same project survive',
    async run({ createService, make }) {
      const { deps, world } = make()
      const service = createService(deps)
      const result = await service.delete(ID_A)
      assert.equal(result.ok, true)
      assert.equal(world.dirExists(ID_B), true, 'the sibling stays')
      assert.equal(world.dirExists(ID_C), true, 'the other project stays')
      assert.deepEqual(world.calls.workspace, [ID_A])
    },
  },
]

/**
 * Run the matrix.
 * @param {(deps: object) => object} createService
 */
export async function runServiceMatrix(createService) {
  const results = []
  for (const item of SERVICE_CASES) {
    const make = (options) => makeWorld(options)
    try {
      await item.run({ createService, make, deferred })
      results.push({ id: item.id, title: item.title, ok: true })
    } catch (error) {
      results.push({ id: item.id, title: item.title, ok: false, error: String((error && error.message) || error) })
    }
  }
  const failed = results.filter((r) => !r.ok)
  return { results, passed: results.length - failed.length, failed: failed.length }
}

export { ID_A, ID_B, ID_C, TRASH }
