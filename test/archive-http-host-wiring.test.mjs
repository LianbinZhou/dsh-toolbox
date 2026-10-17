/**
 * S4-c · the host wiring, driven by the real event.
 *
 * `apply` must not read the switch once. It has to react to
 * `loader/volatile-update`, because that is how the settings card applies a
 * change. A switch that only works after a restart is a placebo.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, archiveOrigins } from '../src/host/index.js'
import { TOKEN_PATH } from '../src/host/features/archive/token-route.js'
import { DELETE_PATH } from '../src/host/features/archive/route-guard.js'

function fakeWebServer() {
  const routes = []
  const disposed = []
  return {
    port: 3080,
    routes,
    disposed,
    register(route) {
      routes.push(route)
      return () => disposed.push(route.path)
    },
  }
}

function fakeCtx({ webServer } = {}) {
  const listeners = new Map()
  const cleanups = []
  return {
    webServer,
    get(name) {
      return name === 'webServer' ? webServer : undefined
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((one) => one !== handler))
      }
    },
    effect(run) {
      // Cordis runs the effect body and tracks what it returns.
      const off = run()
      if (typeof off === 'function') cleanups.push(off)
    },
    tools: { guard: () => () => {} },
    fire(event) {
      for (const handler of listeners.get(event) ?? []) handler()
    },
    teardown() {
      for (const off of cleanups.splice(0).reverse()) off()
    },
  }
}

function config(values) {
  return { quoteReply: false, draftSaver: false, panelMenu: false, archivePanel: false, pluginZh: false, sessionSearch: false, archiveHttpApi: false, ...values }
}

test('wiring · off by default: no route is registered even with a web server', () => {
  const webServer = fakeWebServer()
  const ctx = fakeCtx({ webServer })
  apply(ctx, config())
  assert.equal(webServer.routes.length, 0, 'the 7th switch ships closed')
})

test('wiring · a volatile-update turns the pair on and off live', () => {
  const webServer = fakeWebServer()
  const values = config()
  const ctx = fakeCtx({ webServer })
  apply(ctx, values)

  values.archiveHttpApi = true
  ctx.fire('loader/volatile-update')
  assert.deepEqual(webServer.routes.map((route) => route.path), [TOKEN_PATH, DELETE_PATH])

  values.archiveHttpApi = false
  ctx.fire('loader/volatile-update')
  assert.deepEqual(webServer.disposed, [DELETE_PATH, TOKEN_PATH], 'both routes go down')
  assert.equal(webServer.routes.length, 2, 'and none is re-registered')
})

test('wiring · no web server means no archive HTTP, and nothing throws', () => {
  const ctx = fakeCtx({ webServer: undefined })
  assert.doesNotThrow(() => apply(ctx, config({ archiveHttpApi: true })))
})

test('wiring · teardown removes the routes', () => {
  const webServer = fakeWebServer()
  const ctx = fakeCtx({ webServer })
  apply(ctx, config({ archiveHttpApi: true }))
  assert.equal(webServer.routes.length, 2)
  ctx.teardown()
  assert.equal(webServer.disposed.length, 2)
})

test('origins come from the bound port, never from a header', () => {
  assert.deepEqual(archiveOrigins({ port: 4321 }), ['http://127.0.0.1:4321', 'http://localhost:4321'])
  assert.deepEqual(archiveOrigins(undefined), ['http://127.0.0.1:3080', 'http://localhost:3080'])
})
