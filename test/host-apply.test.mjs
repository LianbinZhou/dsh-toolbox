/**
 * P0-1: the host half must survive a REAL Cordis activation, and S2 moved the
 * probe out in favour of the real `session_search` feature.
 *
 * The S1 review proved that returning a plain object from `apply` throws
 * `Invalid effect` on the real runtime. This file activates it for real.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config, makeGuard, GUARDED_TOOL, DENIAL } from '../index.js'

const ALL_ON = {
  quoteReply: true,
  draftSaver: true,
  panelMenu: true,
  archivePanel: true,
  pluginZh: true,
  sessionSearch: true,
  archiveHttpApi: true,
}

async function activate(applyFn) {
  const root = new Context()
  let error
  try {
    await root.plugin({ apply: applyFn })
  } catch (caught) {
    error = caught
  }
  return { root, error }
}

/** A tools service stub that records what got registered. */
function toolsStub() {
  const registered = []
  const guards = []
  return {
    registered,
    guards,
    register(definition) {
      registered.push(definition)
      return () => {
        definition.disposed = true
      }
    },
    guard(predicate) {
      guards.push(predicate)
      return () => {}
    },
  }
}

const sessionQueryStub = { listSessions: async () => [] }

test('a real Cordis context rejects a plain object returned from apply', async () => {
  const { error } = await activate(() => ({ read: 1 }))
  assert.ok(error, 'returning { read: 1 } must fail')
  assert.match(String(error && error.message), /Invalid effect/)
})

test('a real Cordis context accepts undefined and a disposer', async () => {
  assert.equal((await activate(() => undefined)).error, undefined)
  assert.equal((await activate(() => () => {})).error, undefined)
})

test('the real host apply activates on a real context and installs session_search', async () => {
  const root = new Context()
  const tools = toolsStub()

  let error
  try {
    await root.plugin({
      apply(ctx) {
        ctx.provide('tools', tools)
        ctx.provide('sessionQuery', sessionQueryStub)
        return apply(ctx, Config(ALL_ON))
      },
    })
  } catch (caught) {
    error = caught
  }

  assert.equal(error, undefined, 'the host half must activate cleanly')
  assert.equal(tools.registered.length, 1, 'exactly one tool is registered')
  assert.equal(tools.registered[0].name, 'session_search')
  assert.equal(tools.guards.length, 1, 'the guard is installed once')
  await new Promise((resolve) => setTimeout(resolve, 20))
})

test('apply itself returns nothing (a plain object is Invalid effect)', () => {
  const tools = toolsStub()
  const ctx = {
    tools,
    sessionQuery: sessionQueryStub,
    effect: (fn) => fn(),
    on: () => () => {},
  }
  assert.equal(apply(ctx, Config(ALL_ON)), undefined, 'apply must not return a value')
})

test('apply tolerates a context without a tools service', () => {
  const ctx = { effect: (fn) => fn(), on: () => () => {} }
  assert.doesNotThrow(() => apply(ctx, Config(ALL_ON)))
})

test('apply with the switch off registers no tool at all', () => {
  const tools = toolsStub()
  const ctx = { tools, sessionQuery: sessionQueryStub, effect: (fn) => fn(), on: () => () => {} }
  apply(ctx, Config(Object.assign({}, ALL_ON, { sessionSearch: false })))
  assert.equal(tools.registered.length, 0, 'a disabled switch installs nothing')
})

test('the guard denies its own tool when the switch cannot be read (fail closed)', () => {
  const broken = makeGuard({
    get() {
      throw new Error('settings exploded')
    },
  })
  assert.equal(broken({ name: GUARDED_TOOL }), DENIAL, 'unreadable config denies OUR tool')
  assert.equal(broken({ name: 'read' }), undefined, 'and never touches another tool')
})

test('the guard allows its tool only on an explicit true', () => {
  assert.equal(makeGuard({ sessionSearch: true })({ name: GUARDED_TOOL }), undefined)
  assert.equal(makeGuard({ sessionSearch: false })({ name: GUARDED_TOOL }), DENIAL)
  assert.equal(makeGuard({})({ name: GUARDED_TOOL }), DENIAL, 'a missing key is off')
})
