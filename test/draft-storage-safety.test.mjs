/**
 * S3 · draft-saver Storage safety matrix (A–F).
 *
 * Written BEFORE the new guard existed, on purpose: each case is an assertion
 * the pre-S3 implementation fails. `tools/prove-red.mjs` runs the identical case
 * list against that legacy copy to prove the tests bite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { CASES } from './support/storage-matrix.mjs'
import { makeWorld, draftValue, BACKUP_KEY, DRAFT_PREFIX } from './support/fake-storage.mjs'
import { installDraftGuard } from '../src/client/features/draft-guard.js'

/**
 * A GENUINELY separate module instance (HMR / double eval). The query string
 * gives ESM a distinct cache entry, so this copy has its own `LIVE` WeakMap and
 * can only recognise the first guard through `Symbol.for('dsh.draft-saver.patch')`.
 */
const secondInstance = await import('../src/client/features/draft-guard.js?instance=2')

/** Mount the toolbox guard for one world, from the primary module instance. */
function install(world, options = {}) {
  const getter = options.getStorage ?? (() => world.localStorage)
  return installDraftGuard(getter, options)
}

/** Mount from the second module instance, on the same world. */
function installAgain(world, options = {}) {
  const getter = options.getStorage ?? (() => world.localStorage)
  return secondInstance.installDraftGuard(getter, options)
}

for (const item of CASES) {
  test(item.id + ' · ' + item.title, () => {
    const world = makeWorld()
    item.run({
      world,
      install: (options) => install(world, options),
      installAgain: (options) => installAgain(world, options),
      installOn: (other, options) => install(other, options),
      assert,
      BACKUP_KEY,
      DRAFT_PREFIX,
      draftValue,
      DRAFT_KEY: DRAFT_PREFIX + 'abc123',
    })
  })
}
