/**
 * The committed artifact must be the one the sources produce.
 *
 * This is the direct cure for the archive-manager habit this project replaces
 * ("edit the source, forget to build"). The `test` script deliberately does not
 * pre-build: it reads the committed `client.js`, rebuilds in place, and demands
 * byte equality.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const artifactPath = resolve(root, 'client.js')

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

test('rebuilding the sources reproduces the committed client.js byte for byte', async () => {
  const before = digest(artifactPath)
  // tools/build.mjs runs its build at import time.
  await import('../tools/build.mjs')
  const after = digest(artifactPath)
  assert.equal(
    after,
    before,
    'client.js is stale: run `npm run build` and commit the result (esbuild is pinned to 0.28.2)',
  )
})
