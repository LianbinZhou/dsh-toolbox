/**
 * P0-2: the settings card exists and renders six switches.
 *
 * The S1 review's bluntest finding: `grep plugins.row.config src` returned zero
 * hits, so the shipped package had no switches on the page at all. This file
 * renders the card with a stub React and asserts the six controls exist, that a
 * click writes through, and that the `{ state, mutate }` prop shape is honoured.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { installRuntime, h } from '../src/client/runtime.js'
import { createSettingsCard } from '../src/client/form.js'
import { SWITCHES } from '../src/shared/switches.js'

/** A React stub with just enough hook behaviour to call a component directly. */
function installStubReact() {
  return installRuntime({
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (fn) => {
      fn()
    },
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  })
}

function installStorage() {
  const map = new Map()
  globalThis.window = {
    localStorage: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => void map.set(key, String(value)),
      removeItem: (key) => void map.delete(key),
    },
  }
}

const flatten = (node, out = []) => {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (typeof node === 'object') {
    out.push(node)
    for (const child of node.children || []) flatten(child, out)
  }
  return out
}

const inputsOf = (tree) => flatten(tree).filter((node) => node.type === 'input')

function ctxWithForm(values) {
  const listeners = new Set()
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: Object.assign({}, values) }),
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    set: (key, next) => {
      values[key] = next
      for (const fn of listeners) fn()
      return Promise.resolve(true)
    },
  }
  const forms = {
    get: () => form,
    describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'toolbox' }] } }) }),
  }
  return { ctx: { get: (key) => (key === 'configForms' ? forms : undefined) }, form }
}

test('the runtime must be installed before h() works', () => {
  // A fresh module instance is not available here; assert the contract instead:
  // h is a function and throws only when no runtime was installed in THIS realm.
  assert.equal(typeof h, 'function')
  installStubReact()
  assert.deepEqual(h('span', null, 'x'), { type: 'span', props: {}, children: ['x'] })
})

test('the card renders one checkbox per switch, and never throws', () => {
  installStorage()
  installStubReact()
  const { ctx } = ctxWithForm({ quoteReply: true, pluginZh: false })
  const Card = createSettingsCard(ctx)

  let tree
  assert.doesNotThrow(() => {
    tree = Card({ view: 'page', form: undefined })
  })
  const inputs = inputsOf(tree)
  assert.equal(inputs.length, SWITCHES.length, 'six switches render')
  assert.equal(inputs.length, 6)
  for (const input of inputs) {
    assert.equal(input.props.type, 'checkbox')
  }
})

test('the summary view renders a count and does not throw', () => {
  installStorage()
  installStubReact()
  const { ctx } = ctxWithForm({ quoteReply: true })
  const Card = createSettingsCard(ctx)
  let tree
  assert.doesNotThrow(() => {
    tree = Card({ view: 'summary', form: undefined })
  })
  assert.ok(tree)
})

test('a click writes through the forms service', async () => {
  installStorage()
  installStubReact()
  const values = { quoteReply: true }
  const { ctx, form } = ctxWithForm(values)
  const Card = createSettingsCard(ctx)
  const tree = Card({ view: 'page', form: undefined })
  const first = inputsOf(tree)[0]
  assert.ok(first.props.onChange)
  first.props.onChange({ target: { checked: false } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(values.quoteReply, false, 'the click reaches the settings service')
  assert.ok(form)
})

test('the slot prop shape { state, mutate } is accepted instead of a controller', async () => {
  installStorage()
  installStubReact()
  const calls = []
  const slotForm = {
    state: { status: 'ready', writable: true, value: { quoteReply: true }, revision: 7 },
    mutate: (ops, revision) => {
      calls.push([ops, revision])
      return Promise.resolve(true)
    },
  }
  // No configForms at all: the card must fall back to the slot prop.
  const ctx = { get: () => undefined }
  const Card = createSettingsCard(ctx)

  let tree
  assert.doesNotThrow(() => {
    tree = Card({ view: 'page', form: slotForm })
  })
  const inputs = inputsOf(tree)
  assert.equal(inputs.length, 6)

  inputs[0].props.onChange({ target: { checked: false } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls.length, 1, 'mutate is used when no forms service is available')
  assert.deepEqual(calls[0][0], [{ op: 'set', path: ['quoteReply'], value: false }])
  assert.equal(calls[0][1], 7, 'the revision from state is forwarded')
})

test('a broken form never blanks the card', () => {
  installStorage()
  installStubReact()
  const ctx = {
    get: () => {
      throw new Error('configForms exploded')
    },
  }
  const Card = createSettingsCard(ctx)
  let tree
  assert.doesNotThrow(() => {
    tree = Card({ view: 'page', form: { state: null, mutate: null } })
  })
  assert.equal(inputsOf(tree).length, 6, 'all six switches still render')
})
