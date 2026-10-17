/**
 * P0-1: the host half must survive a REAL Cordis activation.
 *
 * The S1 review proved that returning a plain object from `apply` throws
 * `Invalid effect` on the real runtime — and that no S1 test ever activated it.
 * This file activates it for real.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply as hostApply, apply, Config, PROBE_TOOL, makeGuard, GUARDED_TOOL, DENIAL } from '../index.js'

const ALL_ON = {
  quoteReply: true,
  draftSaver: true,
  panelMenu: true,
  archivePanel: true,
  pluginZh: true,
  sessionSearch: true,
}

/** Activate one plugin on a real Context and settle its fiber. */
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

test('a real Cordis context rejects a plain object returned from apply', async () => {
  const { error } = await activate(() => ({ read: 1 }))
  assert.ok(error, 'returning { read: 1 } must fail')
  assert.match(String(error && error.message), /Invalid effect/)
})

test('a real Cordis context accepts undefined and a disposer', async () => {
  assert.equal((await activate(() => undefined)).error, undefined)
  assert.equal((await activate(() => () => {})).error, undefined)
})

test('the real host apply activates on a real context without throwing', async () => {
  const root = new Context()
  let registers = 0
  let guards = 0
  const tools = {
    register() {
      registers += 1
      return () => {}
    },
    guard() {
      guards += 1
      return () => {}
    },
  }

  let error
  try {
    await root.plugin({
      apply(ctx) {
        ctx.provide('tools', tools)
        return hostApply(ctx, Config(ALL_ON))
      },
    })
  } catch (caught) {
    error = caught
  }

  assert.equal(error, undefined, 'the host half must activate cleanly')
  assert.equal(registers, 1, 'the probe tool is registered once')
  assert.equal(guards, 1, 'the guard is installed once')
  await new Promise((resolve) => setTimeout(resolve, 20))
})

test('apply itself returns nothing (a plain object is Invalid effect)', () => {
  const ctx = { tools: { register: () => () => {}, guard: () => () => {} }, effect: (fn) => fn(), on: () => () => {} }
  const result = apply(ctx, Config(ALL_ON))
  assert.equal(result, undefined, 'apply must not return a value')
})

test('apply tolerates a context without a tools service', () => {
  const ctx = { effect: (fn) => fn(), on: () => () => {} }
  assert.doesNotThrow(() => apply(ctx, Config(ALL_ON)))
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

test('the probe tool name is stable and distinct from the guarded tool', () => {
  assert.equal(PROBE_TOOL, 'toolbox_probe_ping')
  assert.notEqual(PROBE_TOOL, GUARDED_TOOL)
})
