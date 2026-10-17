/**
 * S4-c · the client half. The hard parts are single flight and "only once".
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createArchiveClient, TOKEN_PATH, DELETE_PATH, TOKEN_HEADER } from '../src/client/features/archive-client.js'

const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)

/** A scripted server: token endpoint + delete endpoint, both counted. */
function fakeServer({ tokenFailures = 0, tokenFailAfter = -1, deleteUnauthorized = 0 } = {}) {
  const calls = { token: 0, delete: 0 }
  const urls = []
  const headersSent = []
  let tokenFailureCount = 0
  let unauthorizedLeft = deleteUnauthorized

  async function fetchImpl(url, init = {}) {
    urls.push(url)
    if (url.endsWith(TOKEN_PATH)) {
      calls.token += 1
      // `tokenFailures` fails the first N calls; `tokenFailAfter` succeeds first
      // and fails everything after (the "restart rotated, refresh broken" shape).
      const shouldFail = tokenFailAfter >= 0 ? calls.token > tokenFailAfter : tokenFailureCount < tokenFailures
      if (shouldFail) {
        tokenFailureCount += 1
        return { ok: false, status: 500, json: async () => ({ ok: false }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, token: calls.token === 1 ? TOKEN_A : TOKEN_B }),
      }
    }
    calls.delete += 1
    headersSent.push(init.headers)
    if (unauthorizedLeft > 0) {
      unauthorizedLeft -= 1
      return { ok: false, status: 401, json: async () => ({ ok: false }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, removedDir: true }) }
  }

  return { fetchImpl, calls, urls, headersSent }
}

test('the token never reaches a URL or a global', async () => {
  const server = fakeServer()
  const client = createArchiveClient({ fetchImpl: server.fetchImpl })
  await client.delete('session-aaaaaaaa-1111-2222-3333-444444444444')
  for (const url of server.urls) {
    assert.equal(url.includes(TOKEN_A), false, 'the token must not appear in a URL')
    assert.equal(url.includes(TOKEN_B), false)
  }
  assert.equal(typeof globalThis.localStorage, 'undefined', 'this module must not need web storage')
  assert.equal(client.stats().hasToken, true, 'it lives in the closure')
  assert.equal(TOKEN_HEADER in server.headersSent[0], true, 'and travels in a header')
})

test('concurrent 401s share ONE refresh (single flight)', async () => {
  const server = fakeServer({ deleteUnauthorized: 5 })
  const client = createArchiveClient({ fetchImpl: server.fetchImpl })
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => client.delete('session-' + String(i).padStart(8, '0') + '-1111-2222-3333-444444444444')),
  )
  // One initial token + ONE shared refresh = 2. Five callers must not produce 5.\n  assert.equal(server.calls.token, 2, 'one initial token + one shared refresh; got ' + server.calls.token)\n  assert.equal(client.stats().refreshes, 2)
  assert.equal(results.every((r) => r.ok), true, 'every caller recovered')
  assert.equal(server.calls.delete, 10, 'each caller retried exactly once (5 + 5)')
})

test('a refresh failure is a stable code, and is not retried per caller', async () => {
  const server = fakeServer({ tokenFailAfter: 1, deleteUnauthorized: 3 })
  const client = createArchiveClient({ fetchImpl: server.fetchImpl })
  const results = await Promise.all(
    Array.from({ length: 3 }, () => client.delete('session-aaaaaaaa-1111-2222-3333-444444444444')),
  )
  assert.equal(server.calls.token, 1, 'the single flight also applies to the failure path')
  assert.equal(results.every((r) => r.reason === 'refresh-required'), true)
  assert.equal(server.calls.delete, 3, 'no delete was retried after a failed refresh')
})

test('still 401 after the refresh means refresh-required, no loop', async () => {
  const server = fakeServer({ deleteUnauthorized: 99 })
  const client = createArchiveClient({ fetchImpl: server.fetchImpl })
  const result = await client.delete('session-aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(result.reason, 'refresh-required')
  assert.equal(result.status, 401)
  assert.equal(server.calls.delete, 2, 'exactly one retry, then stop')
})

test('a network error is a code, not an exception', async () => {
  const client = createArchiveClient({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  const result = await client.delete('session-aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'token-unavailable')
})

test('dispose drops the token and the in-flight refresh', async () => {
  const server = fakeServer()
  const client = createArchiveClient({ fetchImpl: server.fetchImpl })
  await client.refresh()
  assert.equal(client.stats().hasToken, true)
  client.dispose()
  assert.equal(client.stats().hasToken, false)
  assert.equal(client.stats().inFlight, false)
  const after = await client.delete('session-aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(after.reason, 'disposed', 'a disposed client answers with a code')
})

test('the second call reuses the cached token (no token storm)', async () => {
  const server = fakeServer()
  const client = createArchiveClient({ fetchImpl: server.fetchImpl })
  await client.delete('session-aaaaaaaa-1111-2222-3333-444444444444')
  await client.delete('session-bbbbbbbb-1111-2222-3333-444444444444')
  assert.equal(server.calls.token, 1, 'one token for the whole session')
  assert.equal(server.calls.delete, 2)
})
