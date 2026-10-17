/**
 * Proof that the S3 safety matrix bites.
 *
 * Runs the SAME cases from `test/support/storage-matrix.mjs` against the pre-S3
 * implementation (`test/fixtures/legacy-guard.mjs`, which patches
 * `Storage.prototype`). A healthy suite must be RED here: if this tool reports
 * everything green, the cases are not testing the flaws they claim to.
 *
 * Usage: node tools/prove-red.mjs
 * Exit code: 0 when at least one case fails (the suite bites), 1 otherwise.
 */

import assert from 'node:assert/strict'
import { CASES, runMatrix } from '../test/support/storage-matrix.mjs'
import { makeWorld, draftValue, BACKUP_KEY, DRAFT_PREFIX } from '../test/support/fake-storage.mjs'
import { createLegacyInstaller } from '../test/fixtures/legacy-guard.mjs'

/**
 * Wrap the legacy installer in the matrix's handle shape.
 * Each call models ONE module instance, which is what makes A5/F2 meaningful.
 */
function legacyInstall(world, options = {}) {
  const installer = createLegacyInstaller()
  const result = installer(world, options)
  const patched = result.used === 'patched'
  return {
    dispose: result.dispose,
    patched,
    reused: result.used !== 'patched',
    status: patched ? 'patched' : 'reused',
    mode: 'prototype',
  }
}

const summary = runMatrix(legacyInstall, legacyInstall)

const pad = (s, n) => String(s).padEnd(n)
console.log('')
console.log('=== S3 safety matrix vs the PRE-S3 implementation ===')
console.log('')
for (const r of summary.results) {
  const mark = r.ok ? 'GREEN' : 'RED  '
  console.log('  [' + mark + '] ' + pad(r.id, 4) + r.title)
  if (!r.ok) console.log('           -> ' + r.error)
}
console.log('')
console.log('  total: ' + summary.results.length + '   RED: ' + summary.failed + '   GREEN: ' + summary.passed)
console.log('')

if (summary.failed === 0) {
  console.log('!!! Every case passed against the legacy implementation.')
  console.log('!!! That means the matrix does NOT bite — fix the tests before touching the guard.')
  process.exit(1)
}

console.log('OK: the matrix catches the legacy design (' + summary.failed + ' red cases).')
process.exit(0)
