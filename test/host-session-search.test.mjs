/**
 * S2: the migrated `session_search` feature.
 *
 * Two things the S1 review and the migration both care about:
 *   - `install` RETURNS the disposer from `ctx.tools.register`. The original
 *     dsh-session-search discarded it, which is why a switch could never remove
 *     the tool.
 *   - A profile without `sessionQuery` (or without `tools`) must degrade to a
 *     no-op instead of crashing the whole toolbox.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../src/host/features/session-search.js'

function toolsStub() {
  const registered = []
  return {
    registered,
    register(definition) {
      registered.push(definition)
      let disposed = false
      definition.isDisposed = () => disposed
      return () => {
        disposed = true
      }
    },
  }
}

test('install registers session_search and returns its disposer', () => {
  const tools = toolsStub()
  const ctx = { tools, sessionQuery: { listSessions: async () => [] } }

  const disposer = install(ctx)
  assert.equal(tools.registered.length, 1, 'one tool registered')
  assert.equal(tools.registered[0].name, 'session_search')
  assert.equal(typeof disposer, 'function', 'the register disposer is returned, not dropped')

  disposer()
  assert.equal(tools.registered[0].isDisposed(), true, 'the tool can really be removed')
})

test('the registered definition carries plain JSON Schema', () => {
  const tools = toolsStub()
  install({ tools, sessionQuery: { listSessions: async () => [] } })
  const definition = tools.registered[0]
  assert.equal(definition.parameters.type, 'object')
  assert.ok(definition.parameters.properties, 'parameters is a JSON Schema object')
  assert.equal(definition.output.schema.type, 'object')
  assert.equal(typeof definition.execute, 'function')
})

test('a missing tools service degrades to a no-op', () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  let disposer
  assert.doesNotThrow(() => {
    disposer = install({})
  })
  console.warn = originalWarn
  assert.equal(typeof disposer, 'function')
  assert.doesNotThrow(() => disposer())
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /tools service is unavailable/)
})

test('a missing sessionQuery degrades to a no-op instead of a broken tool', () => {
  const tools = toolsStub()
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  let disposer
  assert.doesNotThrow(() => {
    disposer = install({ tools })
  })
  console.warn = originalWarn
  assert.equal(tools.registered.length, 0, 'nothing is registered without its dependency')
  assert.equal(typeof disposer, 'function')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /sessionQuery is unavailable/)
})
