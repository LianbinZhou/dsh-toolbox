/**
 * P0-2 (artifact level): the built module registers itself, takes React from the
 * loader, registers the settings card on `plugins.row.config`, and mounts the
 * five client features.
 *
 * The bundle is executed in a fresh `vm` context with a fake `window`, so this is
 * the real committed artifact, not a source-level imitation.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const artifactPath = resolve(root, 'client.js')

const ALL_ON = {
  quoteReply: true,
  draftSaver: true,
  panelMenu: true,
  archivePanel: true,
  pluginZh: true,
  sessionSearch: true,
}

/** A React stub with just enough hook behaviour to call a component directly. */
function stubReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (fn) => {
      fn()
    },
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
}

function loadArtifact() {
  assert.ok(existsSync(artifactPath), 'client.js must exist — run `npm run build` first')
  const code = readFileSync(artifactPath, 'utf8')
  const captured = { calls: 0, config: null }

  const map = new Map()
  const sandbox = {
    console: { info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Object,
    Array,
    Map,
    Set,
    Error,
    TypeError,
    localStorage: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => void map.set(key, String(value)),
      removeItem: (key) => void map.delete(key),
    },
  }
  sandbox.window = { localStorage: sandbox.localStorage, __ModuleLoader__: { load: (config) => {
    captured.calls += 1
    captured.config = config
  } } }
  sandbox.globalThis = sandbox
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })
  captured.window = sandbox.window
  return captured
}

/** A fake client context that records slot registrations. */
function fakeCtx(values) {
  const injected = []
  const registered = []
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: Object.assign({}, values) }),
    subscribe: () => () => {},
    set: () => Promise.resolve(true),
  }
  const forms = {
    get: () => form,
    describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'toolbox' }] } }) }),
  }
  const ctx = {
    get: (key) => (key === 'configForms' ? forms : undefined),
    effect: (fn) => fn(),
    locale: {},
    slots: {
      inject: (key, callback) => {
        injected.push(key)
        const off = callback()
        return typeof off === 'function' ? off : () => {}
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, injected, registered }
}

test('the artifact registers exactly one module under the package id', () => {
  const captured = loadArtifact()
  assert.equal(captured.calls, 1, 'load() must be called once')
  assert.equal(captured.config.id, 'dsh-toolbox', 'the module id must equal the package name')
  assert.equal(typeof captured.config.factory, 'function')
})

test('the artifact has no top-level __require and no bundled React', () => {
  const code = readFileSync(artifactPath, 'utf8')
  assert.equal(code.includes('__require('), false, 'esbuild must not emit a __require shim')
  assert.equal(code.includes('import_react'), false, 'React must not be imported at build time')
  assert.equal(/require\(\s*['"]react['"]\s*\)/.test(code), false, 'no syntactic require("react") may survive')
})

test('the factory takes React from the loader exactly once and returns a plugin', () => {
  const captured = loadArtifact()
  const seen = []
  const plugin = captured.config.factory((specifier) => {
    seen.push(specifier)
    if (specifier === 'react') return stubReact()
    throw new Error('unexpected require: ' + specifier)
  })
  assert.deepEqual(seen, ['react'], 'the loader is asked for react exactly once')
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

test('P0-2: apply registers the settings card on the exact slot key', () => {
  const captured = loadArtifact()
  const { ctx, injected, registered } = fakeCtx(ALL_ON)
  const plugin = captured.config.factory(() => stubReact())
  plugin.apply(ctx)

  assert.ok(injected.includes('plugins.row.config'), 'the row config slot is injected')
  const card = registered.find((entry) => entry.options && entry.options.name === 'plugins.row.config')
  assert.ok(card, 'a cell is registered on plugins.row.config')
  assert.equal(card.options.key, 'dsh-toolbox#toolbox', 'the key is <package>#<row id>')
})

test('P0-2: the registered card renders six checkboxes without throwing', () => {
  const captured = loadArtifact()
  const { ctx, registered } = fakeCtx(ALL_ON)
  const plugin = captured.config.factory(() => stubReact())
  plugin.apply(ctx)

  const card = registered.find((entry) => entry.options && entry.options.name === 'plugins.row.config')
  let tree
  assert.doesNotThrow(() => {
    const wrapper = card.component({ view: 'page', form: undefined })
    // h(cardComponent, props) => { type: cardComponent, props }
    tree = wrapper.type(wrapper.props)
  })
  const flatten = (node, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const child of node) flatten(child, out)
      return out
    }
    out.push(node)
    for (const child of node.children || []) flatten(child, out)
    return out
  }
  const inputs = flatten(tree).filter((node) => node.type === 'input')
  assert.equal(inputs.length, 6, 'six switches render on the row page')
})

test('apply mounts the five client features from the real settings form', async () => {
  const captured = loadArtifact()
  const { ctx } = fakeCtx(ALL_ON)
  const plugin = captured.config.factory(() => stubReact())
  const disposer = plugin.apply(ctx)

  await new Promise((resolve) => setTimeout(resolve, 60))

  const api = captured.window.__DSH_TOOLBOX__
  assert.ok(api, 'apply publishes the diagnostics surface')
  assert.equal(api.liveCount(), 5, 'all five client features mount when every switch is on')
  for (const id of ['quote-reply', 'panel-menu', 'draft-saver', 'archive-panel', 'plugin-zh']) {
    assert.equal(api.phaseOf(id), 'mounted', id + ' must be mounted')
    assert.equal(api.mounts(id), 1, id + ' mounts exactly once')
  }

  assert.equal(typeof disposer, 'function')
  disposer()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(api.liveCount(), 0, 'disposing the plugin unmounts everything')
})
