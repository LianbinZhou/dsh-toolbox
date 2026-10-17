/**
 * P0-2: the built artifact must be a real browser module.
 *
 * The three failure modes this test locks down, all of which the v2 review
 * called "一跑就崩":
 *
 *   1. no `window.__ModuleLoader__.load({ id, factory })` -> the host never loads it;
 *   2. a top-level `__require("react")` emitted by esbuild -> throws in the page;
 *   3. a second React bundled from disk -> breaks hooks and slots.
 *
 * The bundle is executed in a fresh `vm` context with a fake `window`, so this is
 * the real artifact, not a source-level imitation.
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

/** Load the real artifact in a sandbox and return the captured loader call. */
function loadArtifact() {
  assert.ok(existsSync(artifactPath), 'client.js must exist — run `npm run build` first')
  const code = readFileSync(artifactPath, 'utf8')
  const captured = { calls: 0, config: null, window: null }

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
    Node: undefined,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  }
  sandbox.window = {
    localStorage: sandbox.localStorage,
    __ModuleLoader__: {
      load(config) {
        captured.calls += 1
        captured.config = config
      },
    },
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })
  captured.window = sandbox.window
  captured.sandbox = sandbox
  return captured
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
  const reactStub = {
    createElement: () => null,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: () => ({ current: undefined }),
    useSyncExternalStore: () => '',
  }
  const plugin = captured.config.factory((specifier) => {
    seen.push(specifier)
    if (specifier === 'react') return reactStub
    throw new Error('unexpected require: ' + specifier)
  })
  assert.deepEqual(seen, ['react'], 'the loader is asked for react exactly once')
  // The plugin object is built inside the vm realm, so copy before comparing.
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply mounts the client features from the real settings form', async () => {
  const captured = loadArtifact()
  const values = Object.assign({}, ALL_ON)
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
    slots: {},
    locale: {},
  }

  const reactStub = { createElement: () => null }
  const plugin = captured.config.factory(() => reactStub)
  const disposer = plugin.apply(ctx)

  await new Promise((resolve) => setTimeout(resolve, 40))

  const api = captured.window.__DSH_TOOLBOX__
  assert.ok(api, 'apply publishes the diagnostics surface')
  assert.equal(api.liveCount(), 5, 'all five client features mount when every switch is on')
  for (const id of ['quote-reply', 'panel-menu', 'draft-saver', 'archive-panel', 'plugin-zh']) {
    assert.equal(api.phaseOf(id), 'mounted', id + ' must be mounted')
    assert.equal(api.mounts(id), 1, id + ' mounts exactly once')
  }

  assert.equal(typeof disposer, 'function')
  disposer()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(api.liveCount(), 0, 'disposing the plugin unmounts everything')
})
