/**
 * S4-c · the HTTP layer driving the REAL service.
 *
 * Until now `onDelete` answered `503 archive-service-not-wired`. This proves the
 * wire exists end to end: a real HTTP request, through the guard, into
 * `createArchiveService`, moving a real directory into the real trash.
 *
 * It also covers the two routes a migrated panel needs (list, unarchive),
 * because a delete-only panel cannot be migrated.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTokenEndpoint, createTokenRegistry, TOKEN_PATH } from '../src/host/features/archive/token-route.js'
import { createRouteGuard, createDeleteHandler, DELETE_PATH, CSRF_HEADER, TOKEN_HEADER } from '../src/host/features/archive/route-guard.js'
import { createApiHandlers, LIST_PATH, UNARCHIVE_PATH } from '../src/host/features/archive/api-routes.js'
import { createArchiveApi } from '../src/host/features/archive/service-deps.js'

const ID = 'session-aaaaaaaa-1111-2222-3333-444444444444'

async function setup() {
  const base = mkdtempSync(join(tmpdir(), 'tbx-api-'))
  const home = join(base, 'storages')
  const sessions = join(base, 'sessions')
  // Real layout is <sessions>/<project>/<id>: the service derives the sessions
  // root as dirname(dirname(sessionDir)), so a one-level fixture is a false red.
  const projectRoot = join(sessions, 'projA')
  mkdirSync(join(projectRoot, ID), { recursive: true })
  writeFileSync(join(projectRoot, ID, 'session.jsonl'), '{"x":1}\n')

  const archived = new Set([ID])
  const adapter = {
    readArchived: () => [...archived],
    isLive: () => false,
    probe: (id) => ({ state: archived.has(id) ? 'present' : 'absent', dir: join(projectRoot, id) }),
    unarchive: (id) => archived.delete(id),
    dropWorkspaceRows: () => {},
    scrubCache: () => {},
  }
  const built = createArchiveApi({ home, adapter })
  const registry = createTokenRegistry()

  let dispatch = (req, res) => {
    res.writeHead(503)
    res.end()
  }
  const server = createServer((req, res) => dispatch(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = 'http://127.0.0.1:' + port

  const tokenHandler = createTokenEndpoint({ registry, origins: [origin] })
  const guard = createRouteGuard({ allowedOrigins: [origin], token: registry.current(), methods: ['GET', 'POST'] })
  const deleteHandler = createDeleteHandler({ guard, onDelete: (id) => built.api.delete(id), peerOf: (req) => req.socket.remoteAddress })
  const apiHandlers = createApiHandlers({ guard, peerOf: (req) => req.socket.remoteAddress, api: built.api })

  dispatch = (req, res) => {
    if (req.url === TOKEN_PATH) return tokenHandler(req, res)
    if (req.url === DELETE_PATH) return deleteHandler(req, res)
    if (req.url === LIST_PATH) return apiHandlers.list(req, res)
    if (req.url === UNARCHIVE_PATH) return apiHandlers.unarchive(req, res)
    res.writeHead(404)
    res.end()
  }

  const headers = (token) => ({
    'content-type': 'application/json',
    [TOKEN_HEADER]: token,
    [CSRF_HEADER]: '1',
    origin,
    host: '127.0.0.1:' + port,
  })

  return { base, home, sessions, projectRoot, server, port, origin, registry, built, adapter, archived, headers }
}

async function tokenOf(world) {
  const res = await fetch(world.origin + TOKEN_PATH, { headers: { host: '127.0.0.1:' + world.port, origin: world.origin } })
  return (await res.json()).token
}

async function close(world) {
  await new Promise((resolve) => world.server.close(resolve))
  rmSync(world.base, { recursive: true, force: true })
}

test('api · list returns the archived rows', async () => {
  const world = await setup()
  try {
    const value = await tokenOf(world)
    const res = await fetch(world.origin + LIST_PATH, { headers: world.headers(value) })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.rows.some((row) => row.id === ID), true)
  } finally {
    await close(world)
  }
})

test('api · delete through HTTP really moves the directory into the trash', async () => {
  const world = await setup()
  try {
    const value = await tokenOf(world)
    const res = await fetch(world.origin + DELETE_PATH, { method: 'POST', headers: world.headers(value), body: JSON.stringify({ sessionId: ID }) })
    const body = await res.json()
    assert.equal(res.status, 200, 'service said: ' + JSON.stringify(body))
    assert.equal(existsSync(join(world.projectRoot, ID)), false, 'the session directory left its place')
    const journalNow = world.built.deps.journal.read()
    assert.equal(journalNow.length, 1, '记录留在 journal 里，垃圾箱才能列出来')
    assert.equal(journalNow[0].phase, 'cleaned', '阶段是「已进垃圾箱」')
  } finally {
    await close(world)
  }
})

test('api · unarchive clears the flag', async () => {
  const world = await setup()
  try {
    const value = await tokenOf(world)
    const res = await fetch(world.origin + UNARCHIVE_PATH, { method: 'POST', headers: world.headers(value), body: JSON.stringify({ sessionId: ID }) })
    assert.equal(res.status, 200)
    assert.equal(world.archived.has(ID), false, 'unarchive clears the marker')
  } finally {
    await close(world)
  }
})

test('api · without the token every route is 401 and nothing moves', async () => {
  const world = await setup()
  try {
    for (const path of [LIST_PATH, DELETE_PATH, UNARCHIVE_PATH]) {
      const isGet = path === LIST_PATH
      const res = await fetch(world.origin + path, {
        method: isGet ? 'GET' : 'POST',
        headers: { origin: world.origin, host: '127.0.0.1:' + world.port, 'content-type': 'application/json' },
        body: isGet ? undefined : '{}',
      })
      assert.equal(res.status, 401, path + ' must refuse without a token')
    }
    assert.equal(existsSync(join(world.projectRoot, ID)), true, 'and nothing was touched')
  } finally {
    await close(world)
  }
})
