/**
 * R0 attack report: fire the whole matrix at the PRE-S4-b route.
 *
 * A healthy suite must be RED here — the old route answers 200 to every attack
 * shape. Exit code 0 when at least one case fails (the matrix bites), 1 when
 * everything passes (the tests are not testing anything).
 *
 * Usage: node tools/prove-route-red.mjs [--json]
 */

import { ROUTE_CASES, runRouteMatrix } from '../test/support/route-attack.mjs'
import { createLegacyServer } from '../test/fixtures/legacy-archive-route.mjs'

const summary = await runRouteMatrix((onDelete) => ({
  server: createLegacyServer(onDelete),
  token: 'legacy-route-has-no-credential',
}))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  const pad = (s, n) => String(s).padEnd(n)
  console.log('')
  console.log('=== R0/R6 attack matrix vs the PRE-S4-b archive route ===')
  console.log('')
  for (const r of summary.results) {
    const mark = r.skipped ? 'SKIP ' : r.ok ? 'GREEN' : 'RED  '
    console.log('  [' + mark + '] ' + pad(r.id, 6) + r.title)
    if (!r.ok) console.log('           -> ' + r.error)
  }
  console.log('')
  console.log('  total: ' + summary.results.length + '   RED: ' + summary.failed + '   GREEN: ' + summary.passed)
  console.log('')
}

if (summary.failed === 0) {
  console.log('!!! Every attack was accepted. The matrix does not bite.')
  process.exit(1)
}
process.exit(0)
