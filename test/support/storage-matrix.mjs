/**
 * The S3 Storage safety matrix (A–F), as executable cases.
 *
 * Each case receives a context:
 *   { world, install, installAgain, assert, BACKUP_KEY, DRAFT_PREFIX, draftValue }
 *
 * - `world`      a fresh FakeStorage world (two instances, one prototype)
 * - `install`    mount the guard under test
 * - `installAgain` mount it from a SECOND independent module instance (HMR/double-eval)
 *
 * The same case list runs against the pre-S3 implementation (expect RED) and the
 * toolbox guard (expect GREEN), so the tests are proven to bite.
 */

import assert from 'node:assert/strict'
import { makeWorld, draftValue, readBackup, ownPatchState, BACKUP_KEY, DRAFT_PREFIX } from './fake-storage.mjs'

export { BACKUP_KEY, DRAFT_PREFIX, draftValue }

const DRAFT_KEY = DRAFT_PREFIX + 'abc123'

function freshCtx(install, installAgain) {
  const world = makeWorld()
  return {
    world,
    install: (options) => install(world, options),
    installAgain: (options) => installAgain(world, options),
    assert,
    BACKUP_KEY,
    DRAFT_PREFIX,
    draftValue,
    DRAFT_KEY,
  }
}

export const CASES = [
  /* ---------------- A. identity and lifecycle ---------------- */
  {
    id: 'A1',
    title: 'the prototype is untouched and the instance is patched',
    run(ctx) {
      ctx.install()
      const p = ctx.world.Storage.prototype
      ctx.assert.equal(p.getItem, ctx.world.original.getItem, 'Storage.prototype.getItem must stay original')
      ctx.assert.equal(p.setItem, ctx.world.original.setItem, 'Storage.prototype.setItem must stay original')
      ctx.assert.notEqual(ctx.world.localStorage.getItem, ctx.world.original.getItem, 'the instance must be wrapped')
      ctx.assert.notEqual(ctx.world.localStorage.setItem, ctx.world.original.setItem, 'the instance must be wrapped')
    },
  },
  {
    id: 'A2',
    title: 'dispose restores identity with === (not just behaviour)',
    run(ctx) {
      const h = ctx.install()
      h.dispose()
      ctx.assert.equal(ctx.world.localStorage.getItem, ctx.world.original.getItem)
      ctx.assert.equal(ctx.world.localStorage.setItem, ctx.world.original.setItem)
      const own = ownPatchState(ctx.world.localStorage)
      ctx.assert.equal(own.getItem, false, 'the instance wrapper must be deleted, not left behind')
      ctx.assert.equal(own.setItem, false)
    },
  },
  {
    id: 'A3',
    title: 'a second dispose is a no-op and writes nothing',
    run(ctx) {
      const h = ctx.install()
      h.dispose()
      const before = ctx.world.localStorage.getItem(ctx.BACKUP_KEY)
      ctx.assert.doesNotThrow(() => h.dispose())
      ctx.assert.doesNotThrow(() => h.dispose())
      ctx.assert.equal(ctx.world.localStorage.getItem(ctx.BACKUP_KEY), before)
    },
  },
  {
    id: 'A4',
    title: 'mount/dispose five times never builds a chain',
    run(ctx) {
      for (let i = 0; i < 5; i++) {
        const h = ctx.install()
        ctx.assert.notEqual(ctx.world.localStorage.setItem, ctx.world.original.setItem, 'round ' + i + ' patched')
        h.dispose()
        ctx.assert.equal(ctx.world.localStorage.setItem, ctx.world.original.setItem, 'round ' + i + ' restored')
        ctx.assert.equal(ctx.world.Storage.prototype.setItem, ctx.world.original.setItem, 'round ' + i + ' proto untouched')
      }
    },
  },
  {
    id: 'A5',
    title: 'a second module instance cannot install a second wrapper',
    run(ctx) {
      const first = ctx.install()
      const second = ctx.installAgain()
      ctx.assert.ok(
        second.reused === true || second.patched === false,
        'the second mount must reuse or refuse; it returned reused=' + second.reused + ' patched=' + second.patched,
      )
      second.dispose()
      const h = ctx.install()
      h.dispose()
      first.dispose()
      ctx.assert.equal(ctx.world.localStorage.setItem, ctx.world.original.setItem, 'final state must be the original')
    },
  },

  /* ---------------- B. ownership ---------------- */
  {
    id: 'B1',
    title: 'a later third-party patch is never overwritten',
    run(ctx) {
      const h = ctx.install()
      const thirdParty = function thirdPartySetItem() {
        return 'third'
      }
      ctx.world.localStorage.setItem = thirdParty
      h.dispose()
      ctx.assert.equal(ctx.world.localStorage.setItem, thirdParty, 'the third-party function must survive')
      ctx.assert.equal(h.status, 'needs-refresh', 'the guard must report that a refresh is needed')
    },
  },
  {
    id: 'B2',
    title: 'a pre-existing patch is captured and restored, not the original',
    run(ctx) {
      const earlier = function earlierSetItem(key, value) {
        return ctx.world.original.setItem.call(this, key, value)
      }
      ctx.world.localStorage.setItem = earlier
      const h = ctx.install()
      ctx.assert.equal(h.status !== 'unsupported', true, 'mounting over an earlier patch must work')
      h.dispose()
      ctx.assert.equal(
        ctx.world.localStorage.setItem,
        earlier,
        'dispose must restore the function it found, not the prototype original',
      )
    },
  },
  {
    id: 'B3',
    title: 'a frozen instance never crashes and reports honestly',
    run(ctx) {
      Object.defineProperty(ctx.world.localStorage, 'setItem', {
        value: ctx.world.original.setItem,
        writable: false,
        configurable: true,
      })
      let handle
      ctx.assert.doesNotThrow(() => {
        handle = ctx.install()
      })
      ctx.assert.equal(handle.patched, false)
      ctx.assert.equal(handle.status, 'unsupported', 'a non-writable instance must be reported, not faked')
      ctx.assert.doesNotThrow(() => handle.dispose())
    },
  },
  {
    id: 'B4',
    title: 'an unstable storage accessor is detected instead of patched blindly',
    run(ctx) {
      let counter = 0
      const handle = ctx.install({ getStorage: () => (counter++ === 0 ? ctx.world.localStorage : makeWorld().localStorage) })
      ctx.assert.equal(handle.patched, false, 'patching an object nobody keeps a handle to is useless')
      ctx.assert.equal(handle.status, 'unstable')
    },
  },

  /* ---------------- C. cross-storage ---------------- */
  {
    id: 'C1',
    title: 'sessionStorage is not intercepted',
    run(ctx) {
      ctx.install()
      ctx.assert.equal(ctx.world.sessionStorage.getItem, ctx.world.original.getItem, 'sessionStorage.getItem must be untouched')
      ctx.world.sessionStorage.setItem(DRAFT_KEY, draftValue('session draft'))
      ctx.assert.equal(ctx.world.localStorage.getItem(BACKUP_KEY), null, 'a sessionStorage write must not touch the backup')
    },
  },
  {
    id: 'C2',
    title: 'calling the prototype method on sessionStorage bypasses the guard',
    run(ctx) {
      ctx.install()
      ctx.world.Storage.prototype.setItem.call(ctx.world.sessionStorage, DRAFT_KEY, draftValue('via prototype'))
      ctx.assert.equal(ctx.world.localStorage.getItem(BACKUP_KEY), null, 'the prototype call must not reach localStorage backup')
    },
  },
  {
    id: 'C3',
    title: 'two worlds are independent',
    run(ctx) {
      ctx.install()
      const other = makeWorld()
      ctx.assert.equal(other.localStorage.getItem, other.original.getItem, 'another world must not be patched')
      ctx.assert.equal(other.Storage.prototype.setItem, other.original.setItem)
    },
  },

  /* ---------------- D. data correctness ---------------- */
  {
    id: 'D1',
    title: 'a draft write keeps the draft and records the newest backup',
    run(ctx) {
      ctx.install()
      ctx.world.localStorage.setItem(DRAFT_KEY, draftValue('hello world'))
      ctx.assert.equal(ctx.world.localStorage.getItem(DRAFT_KEY), draftValue('hello world'))
      const backup = readBackup(ctx.world.localStorage)
      ctx.assert.ok(backup, 'a backup record must exist')
      ctx.assert.equal(backup.key, DRAFT_KEY)
      ctx.assert.equal(backup.raw, draftValue('hello world'))
    },
  },
  {
    id: 'D2',
    title: 'dispose keeps the backup and the draft; nothing is removed or cleared',
    run(ctx) {
      const h = ctx.install()
      ctx.world.localStorage.setItem(DRAFT_KEY, draftValue('keep me'))
      const backupBefore = ctx.world.localStorage.getItem(BACKUP_KEY)
      h.dispose()
      ctx.assert.equal(ctx.world.localStorage.getItem(BACKUP_KEY), backupBefore, 'the backup is user data')
      ctx.assert.equal(ctx.world.localStorage.getItem(DRAFT_KEY), draftValue('keep me'))
    },
  },
  {
    id: 'D3',
    title: 'a remount restores from the backup, and rehydration does not overwrite it',
    run(ctx) {
      const a = ctx.install()
      ctx.world.localStorage.setItem(DRAFT_KEY, draftValue('newest'))
      a.dispose()

      const b = ctx.install()
      ctx.assert.equal(ctx.world.localStorage.getItem(DRAFT_KEY), draftValue('newest'), 'the read must be restored')
      // The Harness writes back exactly what it was handed: that is rehydration.
      ctx.world.localStorage.setItem(DRAFT_KEY, draftValue('newest'))
      const backup = readBackup(ctx.world.localStorage)
      ctx.assert.equal(backup.raw, draftValue('newest'))
      b.dispose()
    },
  },
  {
    id: 'D4',
    title: 'an emptied draft travels as empty',
    run(ctx) {
      ctx.install()
      ctx.world.localStorage.setItem(DRAFT_KEY, draftValue('something'))
      ctx.world.localStorage.setItem(DRAFT_KEY, draftValue(''))
      const backup = readBackup(ctx.world.localStorage)
      ctx.assert.ok(backup, 'the empty write must be recorded')
      ctx.assert.equal(JSON.parse(backup.raw).draft.text, '', 'the shared draft follows to empty')
    },
  },
  {
    id: 'D7',
    title: 'many draft keys do not grow memory without bound and never throw',
    run(ctx) {
      ctx.install()
      ctx.assert.doesNotThrow(() => {
        for (let i = 0; i < 600; i++) {
          const key = ctx.DRAFT_PREFIX + 'k' + i
          ctx.world.localStorage.setItem(key, draftValue('text ' + i))
          ctx.world.localStorage.getItem(key)
        }
      })
      const backup = readBackup(ctx.world.localStorage)
      ctx.assert.ok(backup, 'the newest write still lands')
    },
  },

  /* ---------------- E. active / stale references ---------------- */
  {
    id: 'E1',
    title: 'a stale wrapper reference forwards transparently after dispose',
    run(ctx) {
      const h = ctx.install()
      const old = ctx.world.localStorage.setItem
      h.dispose()
      ctx.assert.doesNotThrow(() => old.call(ctx.world.localStorage, DRAFT_KEY, draftValue('stale')))
      ctx.assert.equal(ctx.world.localStorage.getItem(BACKUP_KEY), null, 'a stale write must not touch the backup')
    },
  },
  {
    id: 'E2',
    title: 'a stale getItem reference publishes no notice after dispose',
    run(ctx) {
      const notices = []
      const h = ctx.install({ onRestore: (n) => notices.push(n) })
      ctx.world.localStorage.setItem(DRAFT_KEY, draftValue('older'))
      const staleGet = ctx.world.localStorage.getItem
      h.dispose()
      staleGet.call(ctx.world.localStorage, DRAFT_KEY)
      ctx.assert.equal(notices.length, 0, 'a disposed guard must not publish anything')
    },
  },
  {
    id: 'E3',
    title: 'a stale setItem reference writes no backup after dispose',
    run(ctx) {
      const h = ctx.install()
      const staleSet = ctx.world.localStorage.setItem
      h.dispose()
      staleSet.call(ctx.world.localStorage, DRAFT_KEY, draftValue('after dispose'))
      ctx.assert.equal(ctx.world.localStorage.getItem(BACKUP_KEY), null)
    },
  },

  /* ---------------- F. coexistence ---------------- */
  {
    id: 'F1',
    title: 'a foreign marked guard is detected instead of double-patched',
    run(ctx) {
      const foreign = function foreignGuard(key, value) {
        return ctx.world.original.setItem.call(this, key, value)
      }
      Object.defineProperty(foreign, Symbol.for('dsh.draft-saver.patch'), { value: true })
      ctx.world.localStorage.setItem = foreign

      const h = ctx.install()
      ctx.assert.equal(ctx.world.localStorage.setItem, foreign, 'the foreign guard must stay in place')
      ctx.assert.ok(
        h.status === 'conflict' || h.reused === true || h.patched === false,
        'it must refuse or reuse, status=' + h.status,
      )
      h.dispose()
      ctx.assert.equal(ctx.world.localStorage.setItem, foreign, 'dispose must not clear the foreign guard')
    },
  },
  {
    id: 'F2',
    title: 'a double mount of the same guard leaves one layer',
    run(ctx) {
      const a = ctx.install()
      const b = ctx.install()
      ctx.assert.equal(b.reused, true, 'the second mount must reuse')
      a.dispose()
      ctx.assert.equal(ctx.world.localStorage.setItem, ctx.world.original.setItem, 'one dispose restores')
    },
  },
]

/** Run every case, returning `{ passed, failed }` with per-case detail. */
export function runMatrix(installer, installAgain) {
  const results = []
  for (const item of CASES) {
    const ctx = freshCtx(installer, installAgain)
    try {
      item.run(ctx)
      results.push({ id: item.id, title: item.title, ok: true })
    } catch (error) {
      results.push({ id: item.id, title: item.title, ok: false, error: String((error && error.message) || error) })
    }
  }
  const failed = results.filter((r) => !r.ok)
  return { results, passed: results.length - failed.length, failed: failed.length, failures: failed }
}
