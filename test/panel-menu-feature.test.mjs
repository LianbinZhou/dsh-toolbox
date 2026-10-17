/**
 * S4-a · the panel-menu feature.
 *
 * The component tree needs a DOM to render, so these tests cover the CONTRACT:
 * mounting registers two dictionaries and two slots through `env.track`, and a
 * dispose runs every one of them. That is what makes the hard acceptance
 * criterion possible at all: the stylesheet that hides the native sidebar rows is
 * rendered BY the trigger component, so when the trigger's slot is disposed the
 * <style> node leaves with it and the hidden rows come straight back.
 *
 * The visible behaviour (rows disappear, popover opens, rows reappear on switch
 * off) is verified on the real machine.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mount, resetMenuState } from '../src/client/features/panel-menu.js'

function makeCtx(options = {}) {
  const events = []
  const disposals = []
  const ctx = {
    locale: {
      register: (ns, lang) => {
        events.push('locale:' + lang)
        return () => disposals.push('locale:' + lang)
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (slot, callback) => {
        events.push('inject:' + slot)
        return callback()
      },
      register: (slot) => {
        events.push('register:' + slot.id)
        return () => disposals.push(slot.id)
      },
    },
    effect: (fn) => {
      const result = fn()
      events.push('effect')
      return typeof result === 'function' ? result : () => {}
    },
    get: (name) => (name === 'layout' ? { selectPanel() {} } : undefined),
  }
  if (options.layoutThrows) {
    Object.defineProperty(ctx, 'layout', {
      get() {
        throw new Error('cannot get property "layout" without inject')
      },
      configurable: true,
    })
  } else {
    ctx.layout = { selectPanel() {} }
  }
  return { ctx, events, disposals }
}

test('mount registers two dictionaries and two slots', () => {
  const { ctx, events } = makeCtx()
  const tracked = []
  const env = { track: (value) => { tracked.push(value); return value } }

  mount(ctx, env)

  assert.ok(events.includes('locale:zh'))
  assert.ok(events.includes('locale:en'))
  assert.ok(events.includes('inject:sidebar.footer.action'), 'the sidebar trigger slot')
  assert.ok(events.includes('inject:shell.overlay'), 'the frame-wide popover slot')
  assert.ok(events.includes('register:panel-menu.trigger'))
  assert.ok(events.includes('register:panel-menu.menu'))
})

test('every effect of the original apply is tracked, plus the state reset', () => {
  const { ctx } = makeCtx()
  const tracked = []
  const env = { track: (value) => { tracked.push(value); return value } }

  mount(ctx, env)

  assert.equal(tracked.length, 5, '4 original effects + the store reset')
})

test('dispose removes both slots: that is what brings the hidden rows back', () => {
  const { ctx, disposals } = makeCtx()
  const tracked = []
  const env = { track: (value) => { tracked.push(value); return value } }

  mount(ctx, env)
  for (const dispose of tracked) dispose()

  assert.ok(disposals.includes('panel-menu.trigger'), 'the trigger (and its <style>) is removed')
  assert.ok(disposals.includes('panel-menu.menu'), 'the popover is removed')
  assert.equal(disposals.length, 4, 'two dictionaries + two slots, nothing left registered')
})

test('a layout service that is not declared falls back to ctx.get', () => {
  const { ctx } = makeCtx({ layoutThrows: true })
  const env = { track: (value) => value }

  assert.doesNotThrow(() => mount(ctx, env), 'the inject-free path must keep the feature mountable')
})

test('resetMenuState never throws, even before any mount', () => {
  assert.doesNotThrow(() => resetMenuState())
})

test('mount twice in a row stays clean (off/on cycle)', () => {
  const { ctx } = makeCtx()
  const env = { track: (value) => value }

  assert.doesNotThrow(() => {
    mount(ctx, env)
    resetMenuState()
    mount(ctx, env)
  })
})
