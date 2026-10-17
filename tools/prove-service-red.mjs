/**
 * R4/R5 red report: run the service matrix against the PRE-migration algorithm.
 *
 * Six killers (Pi's order): live, unarchive race, becomes-live race, replay,
 * concurrency, rm-then-unarchive stuck. A healthy suite must be RED here.
 *
 * Usage: node tools/prove-service-red.mjs
 */

import { runServiceMatrix } from '../test/support/archive-service-matrix.mjs'
import { createLegacyTombstoneService } from '../test/fixtures/legacy-tombstone-service.mjs'

const summary = await runServiceMatrix(createLegacyTombstoneService)

const pad = (s, n) => String(s).padEnd(n)
console.log('')
console.log('=== R4/R5 service matrix vs the PRE-migration algorithm ===')
console.log('')
for (const r of summary.results) {
  console.log('  [' + (r.ok ? 'GREEN' : 'RED  ') + '] ' + pad(r.id, 6) + r.title)
  if (!r.ok) console.log('           -> ' + r.error)
}
console.log('')
console.log('  total: ' + summary.results.length + '   RED: ' + summary.failed + '   GREEN: ' + summary.passed)
console.log('')

if (summary.failed === 0) {
  console.log('!!! Every case passed against the legacy algorithm. The matrix does not bite.')
  process.exit(1)
}
process.exit(0)
