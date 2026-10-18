/**
 * S4-c · the 7th switch: an experimental HTTP archive API, OFF by default.
 *
 * The switch is not a label. It must control the ROUTE LIFECYCLE: turning it on
 * mounts the token route and the delete route together, turning it off takes them
 * both down and invalidates the old token. A switch that merely records a value
 * is a placebo, and this file exists to make that impossible.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { SWITCHES, SWITCH_KEYS, CLIENT_SWITCH_KEYS } from '../src/shared/switches.js'
import { CONFIG_DEFAULTS, isOn } from '../src/host/config.js'
import { createArchiveHttpLifecycle } from '../src/host/features/archive/host-feature.js'
import { createTokenRegistry, TOKEN_PATH } from '../src/host/features/archive/token-route.js'
import { DELETE_PATH } from '../src/host/features/archive/route-guard.js'

const TOKEN = 't'.repeat(64)
const ORIGINS = ['http://127.0.0.1:3080']

function fakeWebServer() {
  const routes = []
  const disposed = []
  return {
    routes,
    disposed,
    register(route) {
      routes.push(route)
      return () => disposed.push(route.path)
    },
  }
}

function makeLifecycle(overrides = {}) {
  const webServer = fakeWebServer()
  const registry = createTokenRegistry(TOKEN)
  const options = {
    readEnabled: () => false,
    registry,
    webServer,
    token: TOKEN,
    origins: ORIGINS,
    onDelete: () => ({ ok: true }),
    ...overrides,
  }
  return { life: createArchiveHttpLifecycle(options), webServer, registry }
}

test('switch · archiveHttpApi exists, is the 7th, and is host-only', () => {
  assert.equal(SWITCHES.length, 7, 'the settings card shows 7 switches')
  assert.ok(SWITCH_KEYS.includes('archiveHttpApi'))
  assert.equal(CLIENT_SWITCH_KEYS.length, 5, 'the client feature registry stays at 5')
  assert.equal(CLIENT_SWITCH_KEYS.includes('archiveHttpApi'), false, 'it is a HOST switch, not a client feature')
})

test('switch · the config default is OFF', () => {
  assert.equal(CONFIG_DEFAULTS.archiveHttpApi, false, 'shipping default must be closed')
  assert.equal(CONFIG_DEFAULTS.quoteReply, true, 'the other switches keep their old default')
  assert.equal(isOn({}, 'archiveHttpApi'), false, 'a missing value fails closed')
  assert.equal(isOn({ archiveHttpApi: true }, 'archiveHttpApi'), true)
})

test('lifecycle · OFF mounts nothing, and both routes are absent', () => {
  const { life, webServer } = makeLifecycle()
  const state = life.sync()
  assert.equal(state.registered, false)
  assert.equal(webServer.routes.length, 0, 'no token route, no delete route')
})

test('lifecycle · ON mounts the pair', () => {
  const { life, webServer } = makeLifecycle({ readEnabled: () => true })
  const state = life.sync()
  assert.equal(state.registered, true)
  assert.deepEqual(webServer.routes.map((route) => route.path), [TOKEN_PATH, DELETE_PATH, '/api/archive-manager/list', '/api/archive-manager/unarchive', '/api/archive-manager/trash', '/api/archive-manager/restore', '/api/archive-manager/purge'])
})

test('lifecycle · flipping OFF takes BOTH routes down and rotates the token', () => {
  let on = true
  const { life, webServer, registry } = makeLifecycle({ readEnabled: () => on })
  life.sync()
  assert.equal(webServer.routes.length, 7)
  const oldToken = registry.current()

  on = false
  const state = life.sync()
  assert.equal(state.registered, false)
  // Teardown order is deliberate: the destructive route goes down first, then
  // the route that hands out credentials.
  assert.equal(webServer.disposed.length, 7, 'every route is taken down')
  assert.notEqual(registry.current(), oldToken, 'the old credential must not survive the switch')
})

test('lifecycle · sync() is idempotent while the state does not change', () => {
  const { life, webServer } = makeLifecycle({ readEnabled: () => true })
  life.sync()
  life.sync()
  life.sync()
  assert.equal(webServer.routes.length, 7, 'no double registration')
})

test('lifecycle · a failed mount leaves nothing registered and reports why', () => {
  const broken = fakeWebServer()
  let calls = 0
  broken.register = (route) => {
    calls += 1
    if (calls === 2) throw new Error('refused')
    return () => {}
  }
  const registry = createTokenRegistry(TOKEN)
  const life = createArchiveHttpLifecycle({
    readEnabled: () => true,
    registry,
    webServer: broken,
    token: TOKEN,
    origins: ORIGINS,
    onDelete: () => ({ ok: true }),
  })
  const state = life.sync()
  assert.equal(state.registered, false)
  assert.match(state.reason, /refused/)
})

test('lifecycle · dispose() unmounts whatever is mounted', () => {
  const { life, webServer } = makeLifecycle({ readEnabled: () => true })
  life.sync()
  life.dispose()
  assert.equal(webServer.disposed.length, 7)
})
