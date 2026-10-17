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

/** Mount the toolbox guard for one world. */
function install(world, options = {}) {
  const getter = options.getStorage ?? (() => world.localStorage)
  return installDraftGuard(getter, options)
}

for (const item of CASES) {
  test(item.id + ' · ' + item.title, () => {
    const world = makeWorld()
    item.run({
      world,
      install: (options) => install(world, options),
      installAgain: (options) => install(world, options),
      assert,
      BACKUP_KEY,
      DRAFT_PREFIX,
      draftValue,
      DRAFT_KEY: DRAFT_PREFIX + 'abc123',
    })
  })
}
