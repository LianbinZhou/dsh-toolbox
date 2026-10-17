/**
 * The committed artifact must be the one the sources produce.
 *
 * Direct cure for the archive-manager habit this project replaces ("edit the
 * source, forget to build"). The build runs in memory (`write: false`) and the
 * bytes are compared, so a stale artifact fails the test without leaving a dirty
 * working tree.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildOnce } from '../tools/build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const artifactPath = resolve(root, 'client.js')

const digest = (buffer) => createHash('sha256').update(buffer).digest('hex')

test('a fresh in-memory build reproduces the committed client.js byte for byte', async () => {
  const committed = readFileSync(artifactPath)
  const fresh = await buildOnce({ write: false })
  assert.ok(fresh && typeof fresh.text === 'string', 'the in-memory build returned bytes')
  assert.equal(
    digest(Buffer.from(fresh.text, 'utf8')),
    digest(committed),
    'client.js is stale: run `npm run build` and commit the result (esbuild is pinned to 0.28.2)',
  )
})
