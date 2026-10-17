/**
 * P0-3 / P1-1: the switch plumbing.
 *
 * The S1 review found two dead ends here: `watchSwitches` returned a no-op when
 * `configForms` arrived late (switches worked exactly once), and `storeSwitches`
 * had no caller at all (the cache was always empty).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readSwitches,
  watchSwitches,
  cacheSwitches,
  storeSwitches,
  pickForm,
  valuesOf,
} from '../src/client/switches.js'

/** A fake localStorage so the cache round-trip runs. */
function installStorage() {
  const map = new Map()
  const storage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  }
  globalThis.window = { localStorage: storage }
  return storage
}

/** A fake configForms that appears only after `appearAfter` reads. */
function makeCtx(appearAfter, initialValues) {
  const values = Object.assign({}, initialValues)
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
  let reads = 0
  return {
    ctx: {
      get: (key) => {
        if (key !== 'configForms') return undefined
        reads += 1
        return reads > appearAfter ? forms : undefined
      },
    },
    form,
    values,
    listeners,
  }
}

test('P1-1: storeSwitches and cacheSwitches round-trip, tagged by package and row', () => {
  installStorage()
  assert.deepEqual(cacheSwitches(), {}, 'an empty cache reads as {}')
  storeSwitches({ quoteReply: true, pluginZh: false })
  assert.deepEqual(cacheSwitches(), { quoteReply: true, pluginZh: false })
})

test('P1-1: a cache written by another package or row is ignored', () => {
  const storage = installStorage()
  storage.setItem(
    'dsh-toolbox.switches.v1',
    JSON.stringify({ package: 'someone-else', rowId: 'toolbox', values: { quoteReply: true } }),
  )
  assert.deepEqual(cacheSwitches(), {})
})

test('readSwitches retries until configForms appears, then stores the values', async () => {
  installStorage()
  const { ctx } = makeCtx(2, { quoteReply: true, pluginZh: false })
  const values = await readSwitches(ctx, { isCancelled: () => false })
  assert.deepEqual(values, { quoteReply: true, pluginZh: false })
  assert.deepEqual(cacheSwitches(), { quoteReply: true, pluginZh: false }, 'the cache is written now')
})

test('readSwitches resolves {} immediately when cancelled', async () => {
  installStorage()
  const { ctx } = makeCtx(0, { quoteReply: true })
  const values = await readSwitches(ctx, { isCancelled: () => true })
  assert.deepEqual(values, {})
})

test('P0-3: watchSwitches late-binds once configForms appears and then fires', async () => {
  installStorage()
  const { ctx, form } = makeCtx(2, { quoteReply: true, pluginZh: true })
  const seen = []
  const stop = watchSwitches(ctx, (values) => seen.push(values), { isCancelled: () => false })

  // The service appears after a couple of retries; wait for the subscription.
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.ok(seen.length >= 0)

  form.set('quoteReply', false)
  assert.equal(seen.length, 1, 'a late-bound subscription still delivers changes')
  assert.equal(seen[0].quoteReply, false)
  assert.deepEqual(cacheSwitches(), { quoteReply: false, pluginZh: true }, 'the cache follows every change')

  stop()
  form.set('quoteReply', true)
  assert.equal(seen.length, 1, 'a stopped watcher delivers nothing more')
})

test('watchSwitches stops retrying once disposed', async () => {
  installStorage()
  const { ctx } = makeCtx(100, { quoteReply: true })
  let calls = 0
  const stop = watchSwitches(ctx, () => (calls += 1), { isCancelled: () => false })
  stop()
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(calls, 0)
})

test('P1-3: the watch retry is capped instead of polling forever', async () => {
  installStorage()
  // configForms never appears: every attempt returns undefined.
  let reads = 0
  const ctx = { get: () => { reads += 1; return undefined } }

  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))

  const stop = watchSwitches(ctx, () => {}, { isCancelled: () => false, retryMs: 5, maxRetries: 3 })

  await new Promise((resolve) => setTimeout(resolve, 120))
  console.warn = originalWarn
  stop()

  assert.ok(reads >= 3, 'it retried a few times')
  assert.ok(reads <= 4, 'and then stopped: got ' + reads + ' reads')
  assert.equal(warnings.length, 1, 'it complains once instead of spinning silently')
  assert.match(warnings[0], /configForms never appeared/)
})

test('pickForm prefers the row id and falls back to the package ids', () => {
  const { ctx } = makeCtx(0, { quoteReply: true })
  const picked = pickForm(ctx)
  assert.ok(picked)
  assert.equal(picked.entryId, 'toolbox')
  assert.ok(valuesOf(picked.form))
})
