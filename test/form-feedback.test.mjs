/**
 * The per-switch feedback rules, unit-tested without a renderer.
 *
 * The first real screenshot exposed a defect the previous tests could not see:
 * one global `busy` flag disabled ALL six switches during a write, so a single
 * click greyed the whole column for about a second. These helpers are the fix,
 * and they are pure so they can be asserted directly.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveValue, isSwitchDisabled, pruneOverlay } from '../src/client/form.js'

test('only the clicked switch is disabled while its write is in flight', () => {
  const pending = { quoteReply: true }
  assert.equal(isSwitchDisabled(true, pending, 'quoteReply'), true, 'the clicked switch waits')
  assert.equal(isSwitchDisabled(true, pending, 'pluginZh'), false, 'every other switch stays usable')
  assert.equal(isSwitchDisabled(true, {}, 'pluginZh'), false)
})

test('nothing is usable before the values arrive', () => {
  assert.equal(isSwitchDisabled(false, {}, 'quoteReply'), true)
})

test('the optimistic value wins until the source catches up', () => {
  const values = { quoteReply: true, pluginZh: true }
  const overlay = { quoteReply: false }
  assert.equal(resolveValue(values, overlay, 'quoteReply'), false, 'the click is visible immediately')
  assert.equal(resolveValue(values, overlay, 'pluginZh'), true, 'the untouched switch is unchanged')
  assert.equal(resolveValue(undefined, overlay, 'pluginZh'), false, 'no values means off')
})

test('an overlay entry is dropped once the source reports the same value', () => {
  const overlay = { quoteReply: false, pluginZh: true }
  const values = { quoteReply: false, pluginZh: false }
  const pruned = pruneOverlay(overlay, values)
  assert.deepEqual(pruned, { pluginZh: true }, 'a caught-up key is removed; a pending one stays')
})

test('pruning is safe without values or overlay', () => {
  assert.deepEqual(pruneOverlay(undefined, { a: true }), {})
  assert.deepEqual(pruneOverlay({ a: true }, undefined), { a: true })
})
