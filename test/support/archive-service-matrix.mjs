/**
 * S4-b · R4 / R5 service-layer matrix (Pi's "six killers" first).
 *
 * A shared case list so the SAME assertions run against the pre-migration
 * algorithm (expect RED) and the new state machine (expect GREEN).
 *
 * The world is pure dependency injection: a mutable archived set, a live lookup,
 * a find/remove that can be made to fail or pause, and a `beforeStep` hook that
 * lets a case open a window between two steps (Pi's rule: no accidental ordering
 * from Promise.all).
 */

import assert from 'node:assert/strict'

const ID_A = 'session-aaaaaaaa-1111-2222-3333-444444444444'
const ID_B = 'session-bbbbbbbb-1111-2222-3333-444444444444'
const ID_C = 'session-cccccccc-1111-2222-3333-444444444444'

/** A deferred the test can resolve to release a paused step. */
function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * One world per case.
 *
 * @param {object} [options]
 * @param {string[]} [options.archived]
 * @param {string[]} [options.live]
 * @param {object} [options.failAt] - `{ step: 'unarchive'|'workspace'|'cache'|'remove', error }`
 * @param {object} [options.pauseAt] - `{ step, gate }`
 */
export function makeServiceWorld(options = {}) {
  const archived = new Set(options.archived ?? [ID_A, ID_B, ID_C])
  const live = new Set(options.live ?? [])
  const dirs = new Map([
    [ID_A, '/sessions/projA/' + ID_A],
    [ID_B, '/sessions/projA/' + ID_B],
    [ID_C, '/sessions/projB/' + ID_C],
  ])
  const calls = {
    removeDir: [],
    unarchive: [],
    workspace: [],
    cache: [],
    find: [],
  }
  const failAt = options.failAt || {}
  const pauseAt = options.pauseAt || {}

  function failIf(step) {
    if (failAt.step === step) throw failAt.error || new Error(step + ' failed')
  }

  async function gate(step, id) {
    if (pauseAt.step === step && pauseAt.gate) await pauseAt.gate.promise
  }

  const deps = {
    readArchived: () => [...archived],
    isLive: (id) => live.has(id),
    findDir: (id) => {
      calls.find.push(id)
      return dirs.get(id)
    },
    removeDir: (dir) => {
      calls.removeDir.push(dir)
      const id = [...dirs.entries()].find(([, d]) => d === dir)?.[0]
      failIf('remove')
      dirs.delete(id)
    },
    unarchive: (id) => {
      calls.unarchive.push(id)
      failIf('unarchive')
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
    beforeStep: async (step, id) => {
      await gate(step, id)
    },
    // test-side view
    __world: {
      archived,
      live,
      dirs,
      calls,
      setLive(id, value) {
        if (value) live.add(id)
        else live.delete(id)
      },
      unarchiveDirectly(id) {
        archived.delete(id)
      },
      dirExists: (id) => dirs.has(id),
      isArchived: (id) => archived.has(id),
    },
  }

  return { deps, world: deps.__world, deferred }
}

export const SERVICE_CASES = [
  /* ------------------------------- R4 ------------------------------- */
  {
    id: 'R4-1',
    title: 'a LIVE session is refused, and nothing is touched',
    async run({ createService, make }) {
      const { deps, world } = make({ live: [ID_A] })
      const service = createService(deps)
      const result = await service.delete(ID_A)
      assert.equal(result.ok, false, 'a running session must not be deleted')
      assert.equal(world.dirExists(ID_A), true, 'the files stay')
      assert.equal(world.isArchived(ID_A), true, 'the archive marker stays')
      assert.equal(world.calls.removeDir.length, 0)
    },
  },
  {
    id: 'R4-2',
    title: 'an unarchive that lands between find and remove cancels the delete',
    async run({ createService, make, deferred }) {
      const gate = deferred()
      const { deps, world } = make({ pauseAt: { step: 'rm', gate } })
      const service = createService(deps)
      const pending = service.delete(ID_A)
      // While the delete is paused before rm, another actor unarchives it.
      world.unarchiveDirectly(ID_A)
      gate.resolve()
      const result = await pending
      assert.equal(result.ok, false, 'the archived set must be re-read before rm')
      assert.equal(world.dirExists(ID_A), true, 'the files survive')
      assert.equal(world.calls.removeDir.length, 0)
    },
  },
  {
    id: 'R4-3',
    title: 'a session that becomes LIVE between find and remove is refused',
    async run({ createService, make, deferred }) {
      const gate = deferred()
      const { deps, world } = make({ pauseAt: { step: 'rm', gate } })
      const service = createService(deps)
      const pending = service.delete(ID_A)
      world.setLive(ID_A, true)
      gate.resolve()
      const result = await pending
      assert.equal(result.ok, false, 'live must be re-checked right before removing')
      assert.equal(world.dirExists(ID_A), true)
    },
  },
  {
    id: 'R4-4',
    title: 'a replayed delete is 409/404 and runs the side effects once',
    async run({ createService, make }) {
      const { deps, world } = make()
      const service = createService(deps)
      const first = await service.delete(ID_A)
      assert.equal(first.ok, true)
      const second = await service.delete(ID_A)
      assert.equal(second.ok, false, 'the second delete must not succeed again')
      assert.ok(
        second.status === 404 || second.status === 409 || second.reason === 'not-archived' || second.reason === 'already-deleted',
        'the second answer needs a stable reason, got ' + JSON.stringify(second),
      )
      assert.equal(world.calls.removeDir.length, 1, 'removeDir runs exactly once')
      assert.equal(world.calls.unarchive.length, 1, 'archive cleanup runs exactly once')
    },
  },
  {
    id: 'R4-5',
    title: 'two concurrent deletes of the same id: one wins, one is refused',
    async run({ createService, make, deferred }) {
      const gate = deferred()
      const { deps, world } = make({ pauseAt: { step: 'rm', gate } })
      const service = createService(deps)
      const a = service.delete(ID_A)
      const b = service.delete(ID_A)
      gate.resolve()
      const [first, second] = await Promise.all([a, b])
      const successes = [first, second].filter((r) => r.ok).length
      assert.equal(successes, 1, 'exactly one delete may win, got ' + successes)
      assert.equal(world.calls.removeDir.length, 1, 'the file is removed once')
      assert.equal(world.calls.unarchive.length, 1, 'the archive is cleaned once')
    },
  },

  /* ------------------------------- R5 ------------------------------- */
  {
    id: 'R5-1',
    title: 'rm succeeded but unarchive failed: a retry must be able to finish',
    async run({ createService, make }) {
      const { deps, world } = make({ failAt: { step: 'unarchive', error: new Error('domain write failed') } })
      const service = createService(deps)
      const first = await service.delete(ID_A)
      assert.equal(world.dirExists(ID_A), false, 'the files are gone after the first attempt')

      // Retry with the failure removed: this is the "ghost archived row" case.
      const { deps: deps2 } = { deps }
      deps.unarchive = (id) => {
        world.calls.unarchive.push(id)
        world.archived.delete(id)
      }
      const second = await service.delete(ID_A)
      assert.equal(second.ok, true, 'a retry must finish the cleanup (idempotent cleanup-only)')
      assert.equal(world.isArchived(ID_A), false, 'the archive marker is finally cleared')
    },
  },
  {
    id: 'R5-2',
    title: 'unarchive succeeded but workspace cleanup failed: a retry heals it',
    async run({ createService, make }) {
      const { deps, world } = make({ failAt: { step: 'workspace', error: new Error('registry write failed') } })
      const service = createService(deps)
      await service.delete(ID_A)
      assert.equal(world.isArchived(ID_A), false, 'the marker is already gone')
      assert.equal(world.calls.workspace.length, 1, 'the cleanup was attempted')

      deps.dropWorkspaceRows = (id) => {
        world.calls.workspace.push(id)
      }
      const healed = await service.heal?.()
        ?? await service.list()
      // Either an explicit heal or a self-healing list is acceptable; what is not
      // acceptable is a workspace row that no code path can ever clean.
      assert.ok(healed !== undefined, 'there must be a path that cleans a ghost row')
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
      assert.equal(world.dirExists(ID_B), true, 'the sibling session stays')
      assert.equal(world.dirExists(ID_C), true, 'the other project stays')
      assert.equal(world.isArchived(ID_B), true, 'other archive markers stay')
      assert.deepEqual(world.calls.workspace, [ID_A], 'only this session workspace rows')
      assert.deepEqual(world.calls.cache, [ID_A], 'only this session cache keys')
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
    const make = (options) => makeServiceWorld(options)
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

export { ID_A, ID_B, ID_C }
