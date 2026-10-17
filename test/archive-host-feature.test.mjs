/**
 * S4-c · the archive feature mount: the token route and the delete route are one
 * unit. Half a pair is worse than nothing, so every failure must roll back.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mountArchiveRoutes } from '../src/host/features/archive/host-feature.js'
import { createTokenRegistry, TOKEN_PATH } from '../src/host/features/archive/token-route.js'
import { DELETE_PATH } from '../src/host/features/archive/route-guard.js'

const TOKEN = 't'.repeat(64)
const ORIGINS = ['http://127.0.0.1:3080']

function fakeWebServer({ throwOn = -1 } = {}) {
  const routes = []
  const disposed = []
  let calls = 0
  return {
    routes,
    disposed,
    register(route) {
      calls += 1
      if (calls === throwOn) throw new Error('webServer refused route ' + calls)
      routes.push(route)
      return () => disposed.push(route.path)
    },
  }
}

function base(options = {}) {
  return {
    webServer: fakeWebServer(),
    token: TOKEN,
    origins: ORIGINS,
    registry: createTokenRegistry(TOKEN),
    onDelete: () => ({ ok: true }),
    enabled: true,
    ...options,
  }
}

test('a pair is mounted together: token route + delete route', () => {
  const options = base()
  const result = mountArchiveRoutes(options)
  assert.equal(result.registered, true)
  assert.deepEqual(result.routes, [TOKEN_PATH, DELETE_PATH])
  assert.deepEqual(options.webServer.routes.map((route) => route.path), [TOKEN_PATH, DELETE_PATH])
  assert.equal(options.webServer.routes[0].kind, 'exact')
  assert.equal(options.webServer.routes[0].method, 'GET')
})

test('disabled by configuration mounts NOTHING', () => {
  const options = base({ enabled: false })
  const result = mountArchiveRoutes(options)
  assert.equal(result.registered, false)
  assert.match(result.reason, /disabled/)
  assert.equal(options.webServer.routes.length, 0)
})

test('no token, no origins, no webServer or no registry mounts NOTHING', () => {
  const cases = [
    { token: '' },
    { token: 'short' },
    { origins: [] },
    { webServer: null },
    { registry: null },
    { onDelete: null },
  ]
  for (const patch of cases) {
    const options = base(patch)
    const result = mountArchiveRoutes(options)
    assert.equal(result.registered, false, JSON.stringify(Object.keys(patch)))
    if (options.webServer) assert.equal(options.webServer.routes.length, 0, 'nothing may be mounted')
  }
})

test('a failure on the SECOND registration rolls the first one back', () => {
  const options = base({ webServer: fakeWebServer({ throwOn: 2 }) })
  const result = mountArchiveRoutes(options)
  assert.equal(result.registered, false, 'a half-mounted pair is not a success')
  assert.match(result.reason, /refused route 2/)
  assert.equal(options.webServer.routes.length, 1, 'the token route was registered…')
  assert.deepEqual(options.webServer.disposed, [TOKEN_PATH], '…and then taken back down')
})

test('a failure on the FIRST registration leaves nothing behind', () => {
  const options = base({ webServer: fakeWebServer({ throwOn: 1 }) })
  const result = mountArchiveRoutes(options)
  assert.equal(result.registered, false)
  assert.equal(options.webServer.routes.length, 0)
  assert.deepEqual(options.webServer.disposed, [])
})

test('dispose removes both routes and is idempotent', () => {
  const options = base()
  const result = mountArchiveRoutes(options)
  assert.equal(result.registered, true)
  result.dispose()
  assert.equal(result.dispose(), undefined, 'a second dispose is a no-op')
  assert.equal(options.webServer.disposed.length, 2, 'exactly two disposals, no double-teardown')
})

test('dispose never throws even when a route disposer does', () => {
  const options = base()
  const original = options.webServer.register
  options.webServer.register = (route) => {
    const off = original(route)
    return () => {
      off()
      throw new Error('disposer exploded')
    }
  }
  const result = mountArchiveRoutes(options)
  assert.doesNotThrow(() => result.dispose())
})
