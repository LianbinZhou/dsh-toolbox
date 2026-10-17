/**
 * S2: the migrated quote-reply feature.
 *
 * The component code arrived verbatim from `dsh-plugins/dsh-quote-reply`; what
 * the container cares about is the contract: mount registers both slots plus the
 * two locale dictionaries THROUGH env.track, so switching the feature off really
 * removes the selection menu and the composer sink.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mount } from '../src/client/features/quote-reply.js'

/** A context that records every registration and hands back a disposer. */
function makeCtx() {
  const events = []
  const disposals = []
  const ctx = {
    locale: {
      register: (ns, lang) => {
        events.push('locale:' + ns + ':' + lang)
        return () => disposals.push('locale:' + lang)
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (slot, callback) => {
        events.push('inject:' + slot)
        return callback()
      },
      register: (options) => {
        events.push('register:' + options.id)
        return () => disposals.push(options.id)
      },
    },
    effect: (fn) => {
      const result = fn()
      events.push('effect')
      return typeof result === 'function' ? result : () => {}
    },
  }
  return { ctx, events, disposals }
}

test('mount registers the two locale dictionaries and the two slots', () => {
  const { ctx, events } = makeCtx()
  const tracked = []
  const env = { track: (value) => { tracked.push(value); return value } }

  mount(ctx, env)

  assert.ok(events.includes('locale:dsh-quote-reply:zh'), 'the zh dictionary is registered')
  assert.ok(events.includes('locale:dsh-quote-reply:en'), 'the en dictionary is registered')
  assert.ok(events.includes('inject:shell.overlay'), 'the selection menu slot is used')
  assert.ok(events.includes('inject:conversation.input.overlay'), 'the composer sink slot is used')
  assert.ok(events.includes('register:quote-reply.menu'), 'the menu entry is registered')
  assert.ok(events.includes('register:quote-reply.sink'), 'the sink entry is registered')
})

test('every effect goes through env.track so a switch can undo it', () => {
  const { ctx } = makeCtx()
  const tracked = []
  const env = { track: (value) => { tracked.push(value); return value } }

  mount(ctx, env)
  assert.equal(tracked.length, 4, 'two dictionaries + two slot registrations are tracked')
})

test('calling the tracked disposers removes every registration', () => {
  const { ctx, disposals } = makeCtx()
  const tracked = []
  const env = { track: (value) => { tracked.push(value); return value } }

  mount(ctx, env)
  for (const dispose of tracked) dispose()

  assert.equal(disposals.length, 4, 'every registration has a working disposer')
  assert.ok(disposals.includes('quote-reply.menu'))
  assert.ok(disposals.includes('quote-reply.sink'))
})

test('mount never touches React at mount time (no runtime needed)', () => {
  // The components only call h() when they render; mounting must be component-free.
  const { ctx } = makeCtx()
  const env = { track: (value) => value }
  assert.doesNotThrow(() => mount(ctx, env))
})
