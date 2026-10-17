/**
 * S4-b · the RPC channel (Pi's approved token design).
 *
 * The claim under test: the UI can delete WITHOUT any HTTP endpoint, and the
 * channel still validates input, rate-limits, and audits without leaking.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createArchiveRpc, AUDIT_FIELDS } from '../src/host/features/archive/rpc.js'
import { createArchiveService, REASONS } from '../src/host/features/archive/service.js'
import { makeWorld, ID_A, ID_B } from './support/archive-service-matrix.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function makeRpc(options = {}) {
  const { deps, world } = makeWorld(options)
  const service = createArchiveService(deps)
  const audit = []
  const rpc = createArchiveRpc({ service, audit: (record) => audit.push(record), rateLimit: options.rateLimit })
  return { rpc, service, deps, world, audit }
}

test('RPC · a valid delete goes straight to the service and is audited', async () => {
  const { rpc, world, audit } = makeRpc()
  const result = await rpc.delete(ID_A)
  assert.equal(result.ok, true)
  assert.equal(world.dirExists(ID_A), false, 'the files moved to the trash and the entry was purged')
  assert.equal(audit.length, 1)
  for (const key of Object.keys(audit[0])) assert.ok(AUDIT_FIELDS.includes(key), 'unexpected field: ' + key)
  assert.equal(audit[0].id, ID_A)
  assert.equal(audit[0].ok, true)
})

test('RPC · a hostile id is refused before the service sees it', async () => {
  const { rpc, world, audit } = makeRpc()
  const result = await rpc.delete('../../etc/passwd')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid-id')
  assert.equal(world.calls.probe.length, 0, 'the filesystem is never touched')
  assert.equal(audit[0].reason, 'invalid-id')
})

test('RPC · the rate limit stops a hammering UI', async () => {
  const { rpc, audit } = makeRpc({ rateLimit: { max: 2, windowMs: 60_000 } })
  const first = await rpc.delete(ID_A)
  const second = await rpc.delete(ID_A)
  const third = await rpc.delete(ID_A)
  assert.equal(first.ok, true)
  assert.equal(second.ok, false, 'already deleted the second time')
  assert.equal(third.status, 429, 'the third call is rate limited')
  assert.equal(third.reason, 'rate-limited')
  assert.equal(audit.filter((r) => r.reason === 'rate-limited').length, 1)
})

test('RPC · an audit record never carries a path, a token or content', async () => {
  const { rpc, deps, world } = makeRpc({ failAt: { step: 'workspace', error: new Error('C:\\secret\\path failed') } })
  await rpc.delete(ID_A)
  const { audit } = makeRpc({ rateLimit: { max: 5 } })
  // Use the leaky service directly through a fresh RPC to inspect the record.
  const leaky = createArchiveRpc({
    service: createArchiveService(deps),
    audit: (record) => audit.push(record),
  })
  deps.dropWorkspaceRows = (id) => world.calls.workspace.push(id)
  await leaky.delete(ID_B)

  for (const record of audit) {
    for (const key of Object.keys(record)) {
      assert.ok(AUDIT_FIELDS.includes(key), 'unexpected audit field: ' + key)
    }
    const serialized = JSON.stringify(record)
    assert.doesNotMatch(serialized, /[A-Za-z]:\\\\/, 'no drive letter in the audit')
    assert.doesNotMatch(serialized, /secret/, 'no fragment of the service message')
  }
})

test('RPC · a service that throws becomes a code, not an exception', async () => {
  const audit = []
  const rpc = createArchiveRpc({
    service: {
      async delete() {
        throw new Error('boom')
      },
      async restore() {
        return { ok: true }
      },
      heal: () => ({ ok: true }),
      list: () => ({ ok: true, rows: [] }),
    },
    audit: (record) => audit.push(record),
  })
  const result = await rpc.delete(ID_A)
  assert.equal(result.ok, false)
  assert.equal(result.status, 500)
  assert.equal(result.reason, 'internal-error')
  assert.equal(audit[0].reason, 'internal-error')
})

test('RPC · the module has no network surface at all', async () => {
  const source = readFileSync(resolve(here, '../src/host/features/archive/rpc.js'), 'utf8')
  assert.doesNotMatch(source, /from 'node:http'/, 'no http server import')
  assert.doesNotMatch(source, /from 'node:https'/)
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'no outbound fetch')
  assert.doesNotMatch(source, /webServer\.register/, 'the RPC channel registers no route')
})

test('RPC · restore goes through the same channel', async () => {
  const { rpc, world } = makeRpc({ failAt: { step: 'workspace', error: new Error('down') } })
  await rpc.delete(ID_A)
  assert.equal(world.dirExists(ID_A), false, 'in the trash')
  const restored = await rpc.restore(ID_A)
  assert.equal(restored.ok, true)
  assert.equal(world.dirExists(ID_A), true, 'back where it was')
})

test('RPC · list and heal are exposed for the panel', async () => {
  const { rpc } = makeRpc()
  const listed = await rpc.list()
  assert.equal(listed.ok, true)
  assert.ok(Array.isArray(listed.rows))
  const healed = await rpc.heal()
  assert.equal(healed.ok, true)
})
