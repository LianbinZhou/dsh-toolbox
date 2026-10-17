/**
 * S4-b · the RPC channel after Pi's review: every method takes a PRINCIPAL.
 * These are the attack cases, not the happy path.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createArchiveRpc, createArchiveGateway, METHODS, pickResponse } from '../src/host/features/archive/rpc.js'
import { AUDIT_FIELDS, createMemoryAudit } from '../src/host/features/archive/audit.js'
import { createArchiveService } from '../src/host/features/archive/service.js'
import { registerArchiveRoutes } from '../src/host/features/archive/route-guard.js'
import { makeWorld, ID_A, ID_B } from './support/archive-service-matrix.mjs'

const UI = { id: 'local-ui', role: 'ui', local: true, source: 'panel' }
const REMOTE = { id: 'pad-1', role: 'remote', local: false, source: 'pairing' }
const AGENT = { id: 'agent-1', role: 'agent', local: false }

function setup(options = {}) {
  const { deps, world } = makeWorld(options)
  const service = createArchiveService(deps)
  const records = []
  const rpc = createArchiveRpc({ service, audit: createMemoryAudit(records), rateLimit: options.rateLimit })
  return { rpc, service, deps, world, records }
}

test('RPC · the local UI can delete, and the audit names the actor', async () => {
  const { rpc, world, records } = setup()
  assert.equal((await rpc.delete(UI, ID_A)).ok, true)
  assert.equal(world.dirExists(ID_A), false)
  assert.equal(records[0].actor, 'local-ui')
  assert.equal(records[0].action, METHODS.DELETE)
})

test('RPC · unauthenticated is 401 and touches nothing', async () => {
  const { rpc, world } = setup()
  const result = await rpc.delete(undefined, ID_A)
  assert.equal(result.status, 401)
  assert.equal(world.calls.probe.length, 0)
})

test('RPC · a remote device and an agent are both 403', async () => {
  const { rpc, world, records } = setup()
  assert.equal((await rpc.delete(REMOTE, ID_A)).status, 403)
  assert.equal((await rpc.delete(AGENT, ID_A)).status, 403)
  assert.equal(world.dirExists(ID_A), true)
  assert.equal(records.every((r) => r.reason === 'forbidden'), true)
})

test('RPC · a custom authorizer can grant a role', async () => {
  const { deps, world } = makeWorld()
  const service = createArchiveService(deps)
  const rpc = createArchiveRpc({ service, authorize: (principal) => principal.id === 'trusted-pad' })
  assert.equal((await rpc.delete({ id: 'trusted-pad', role: 'remote' }, ID_A)).ok, true)
  assert.equal(world.dirExists(ID_A), false)
})

test('RPC · a hostile id is refused before the service sees it', async () => {
  const { rpc, world } = setup()
  assert.equal((await rpc.delete(UI, '../../etc/passwd')).status, 400)
  assert.equal(world.calls.probe.length, 0)
})

test('RPC · the response is whitelisted; a leaky service cannot leak a path', async () => {
  const leaky = {
    delete: async () => ({ ok: false, status: 409, reason: 'delete refused', error: 'C:\\secret' }),
    restore: async () => ({ ok: true, debug: '/Users/x/secret' }),
    heal: () => ({ ok: true }),
    list: () => ({ ok: true, rows: [] }),
  }
  const records = []
  const rpc = createArchiveRpc({ service: leaky, audit: createMemoryAudit(records) })
  const result = await rpc.delete(UI, ID_A)
  assert.doesNotMatch(JSON.stringify(result), /secret/)
  assert.equal(result.reason, 'delete refused')
  assert.doesNotMatch(JSON.stringify(await rpc.restore(UI, ID_A)), /secret/)
  assert.doesNotMatch(JSON.stringify(records), /secret/)
})

test('RPC · restore that throws becomes a code', async () => {
  const service = {
    delete: async () => ({ ok: true }),
    restore: async () => { throw new Error('C:\\secret\\boom') },
    heal: () => ({ ok: true }),
    list: () => ({ ok: true, rows: [] }),
  }
  const records = []
  const rpc = createArchiveRpc({ service, audit: createMemoryAudit(records) })
  const result = await rpc.restore(UI, ID_A)
  assert.equal(result.status, 500)
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(records), /secret/)
})

test('RPC · the rate limit is per actor', async () => {
  const { rpc } = setup({ rateLimit: { perActor: 2, perId: 99, windowMs: 60000 } })
  assert.equal((await rpc.delete(UI, ID_A)).ok, true)
  assert.equal((await rpc.delete(UI, ID_B)).ok, true)
  assert.equal((await rpc.delete(UI, ID_A)).status, 429)
})

test('RPC · audit records never carry a non-whitelisted field', async () => {
  const { rpc, records } = setup()
  await rpc.delete(UI, ID_A)
  for (const record of records) {
    for (const key of Object.keys(record)) assert.ok(AUDIT_FIELDS.includes(key), 'unexpected field: ' + key)
  }
})

test('gateway · dispatches, refuses unknown methods, requires a principal', async () => {
  const { rpc, world } = setup()
  const gateway = createArchiveGateway({ rpc })
  assert.ok(gateway.methods.includes(METHODS.DELETE))
  assert.equal((await gateway.dispatch({ method: METHODS.DELETE, principal: UI, params: { sessionId: ID_A } })).ok, true)
  assert.equal(world.dirExists(ID_A), false)
  assert.equal((await gateway.dispatch({ method: 'archive.nuke', principal: UI })).status, 404)
  assert.equal((await gateway.dispatch({ method: 42 })).status, 400)
  for (const method of [METHODS.DELETE, METHODS.RESTORE, METHODS.LIST, METHODS.HEAL]) {
    assert.equal((await gateway.dispatch({ method, params: { sessionId: ID_A } })).status, 401, method)
  }
  assert.equal((await gateway.dispatch({ method: METHODS.DELETE, principal: AGENT, params: { sessionId: ID_A } })).status, 403)
})

test('the response whitelist drops unknown fields', () => {
  const picked = pickResponse({ ok: true, removedDir: true, rows: [], secret: 'C:\\x', status: 200 })
  assert.deepEqual(Object.keys(picked).sort(), ['ok', 'removedDir', 'rows', 'status'])
})

test('the HTTP delete route is closed unless explicitly enabled', () => {
  const registered = []
  const webServer = { register: (route) => { registered.push(route); return () => {} } }
  const base = { webServer, token: 'x'.repeat(64), origins: ['http://127.0.0.1:3080'], onDelete: () => ({ ok: true }) }
  const off = registerArchiveRoutes(base)
  assert.equal(off.registered, false)
  assert.match(off.reason, /disabled/)
  assert.equal(registered.length, 0)
  assert.equal(registerArchiveRoutes({ ...base, enabled: true }).registered, true)
  assert.equal(registered.length, 1)
})
