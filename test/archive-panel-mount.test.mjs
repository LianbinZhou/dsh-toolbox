/**
 * S4-c · the archive panel mount contract.
 *
 * Regression for the real-machine failure: `const rowReg = ...` was accidentally
 * placed after a literal `\n` inside a comment, so the sidebar row was never
 * registered. The source still referenced `rowReg` via `typeof`, which is legal
 * on an undeclared identifier, so it failed silently (no ReferenceError) and all
 * 322 tests stayed green.
 *
 * This test asserts the two registrations the real host needs:
 *   - main     -> keyed slot, key = panel id
 *   - sidebar  -> list slot, id = panel id
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mount, PANEL_ID, MAIN_SLOT, PANEL_SLOT } from '../src/client/features/archive-panel.js'

function makeCtx() {
  const registrations = []
  const injects = []
  const disposals = []
  const ctx = {
    slots: {
      inject(name, callback) {
        injects.push(name)
        const result = callback()
        return typeof result === 'function' ? result : () => {}
      },
      register(options) {
        registrations.push(options)
        return () => disposals.push(options)
      },
      entriesOfSlot() {
        return registrations.map((options) => ({ options }))
      },
    },
    get(name) {
      if (name === 'configForms') {
        const form = {
          getSnapshot: () => ({ value: { archiveHttpApi: true } }),
          subscribe: () => () => {},
        }
        return {
          get: () => form,
          describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'toolbox' }] } }) }),
        }
      }
      return undefined
    },
  }
  return { ctx, registrations, injects, disposals }
}

test('mount registers the main panel AND the sidebar panellist row', () => {
  const { ctx, registrations, injects } = makeCtx()
  const tracked = []
  const env = { track: (value) => { tracked.push(value); return value } }

  mount(ctx, env)

  assert.ok(injects.includes(PANEL_SLOT), 'the row must go through slots.inject')
  const main = registrations.find((options) => options.name === MAIN_SLOT)
  assert.ok(main, 'main panel registration missing')
  assert.equal(main.key, PANEL_ID)

  const row = registrations.find((options) => options.name === PANEL_SLOT)
  assert.ok(row, 'sidebar.panellist row registration missing')
  assert.equal(row.id, PANEL_ID, 'the list slot needs id, not key')
  assert.equal(row.order, 200)
  assert.equal(row.label, '历史归档')
})

test('disposing the mount removes both registrations', () => {
  const { ctx, disposals } = makeCtx()
  const tracked = []
  const env = { track: (value) => { tracked.push(value); return value } }

  const dispose = mount(ctx, env)
  assert.equal(typeof dispose, 'function')
  // The container's scope owns the tracked registrations and the returned cleanup.
  for (const stop of tracked) {
    if (typeof stop === 'function') stop()
  }
  dispose()
  assert.ok(disposals.some((options) => options.name === MAIN_SLOT))
  assert.ok(disposals.some((options) => options.name === PANEL_SLOT))
})
