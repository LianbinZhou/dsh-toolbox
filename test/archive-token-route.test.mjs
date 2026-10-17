/**
 * S4-c 退路 · the token endpoint (Pi's plan A) — RED FIRST.
 *
 * The delete route already refuses without a per-process token. The missing piece
 * is how the UI gets that token without exposing it to anything else:
 *
 *   GET /api/archive-manager/token
 *     - same-origin only (no ACAO at all),
 *     - `Cache-Control: no-store`,
 *     - no side effects (it never deletes, never logs the token),
 *     - same Host allowlist and X-Forwarded-* refusal as delete,
 *     - the token travels in the JSON body, never in a URL, header echo or log.
 *
 * These tests are written against the planned API and must be RED until
 * `src/host/features/archive/token-route.js` exists.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  TOKEN_PATH,
  createTokenEndpoint,
  createTokenRegistry,
  sameToken,
} from '../src/host/features/archive/token-route.js'

const ORIGIN = 'http://127.0.0.1:3080'

async function startEndpoint(options = {}) {
  const registry = createTokenRegistry()
  const server = createServer(createTokenEndpoint({ registry, origins: [ORIGIN], ...options }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { server, port, registry, url: 'http://127.0.0.1:' + port + TOKEN_PATH }
}

async function get(url, init = {}) {
  const response = await fetch(url, init)
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch (error) {
    json = undefined
  }
  return { status: response.status, headers: response.headers, text, json }
}

test('token · a same-origin GET returns the process token with no-store', async () => {
  const { server, port, url, registry } = await startEndpoint()
  try {
    const res = await get(url, { headers: { host: '127.0.0.1:' + port } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(typeof res.json.token, 'string')
    assert.ok(res.json.token.length >= 32, 'a real per-process token')
    assert.equal(res.json.token, registry.current(), 'and it is the live one')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('token · no CORS headers, so a foreign page cannot read the body', async () => {
  const { server, port, url } = await startEndpoint()
  try {
    const res = await get(url, { headers: { host: '127.0.0.1:' + port, origin: 'http://evil.example' } })
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'no ACAO ever')
    assert.equal(res.headers.get('access-control-allow-credentials'), null)
    assert.ok(res.status === 403 || res.status === 200, 'either refuse or answer without CORS; never grant')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('token · a proxied request is refused (X-Forwarded-For)', async () => {
  const { server, port, url } = await startEndpoint()
  try {
    const res = await get(url, { headers: { host: '127.0.0.1:' + port, 'x-forwarded-for': '203.0.113.5' } })
    assert.equal(res.status, 403)
    assert.equal(res.json?.token, undefined, 'no token may leak to a proxied caller')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('token · a Host we do not listen on is refused (DNS rebinding)', async () => {
  const { server, port } = await startEndpoint()
  try {
    // fetch (undici) silently refuses to forge `Host`, so this case has to be a
    // raw request — which is exactly what a rebound page produces on the wire.
    const { request } = await import('node:http')
    const res = await new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: TOKEN_PATH, method: 'GET', headers: { host: 'evil.example' } },
        (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => { text += chunk })
          response.on('end', () => resolve({ status: response.statusCode, text }))
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(res.status, 403, 'a Host we do not listen on must be refused')
    assert.equal(res.text.includes('token'), false, 'no token may leak to a rebound caller')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('token · the endpoint has no side effects and returns no path or stack', async () => {
  const { server, port, url, registry } = await startEndpoint()
  try {
    const before = registry.current()
    const res = await get(url, { headers: { host: '127.0.0.1:' + port } })
    assert.equal(registry.current(), before, 'issuing a token does not rotate it')
    assert.doesNotMatch(res.text, /[A-Za-z]:\\\\/, 'no drive letter')
    assert.doesNotMatch(res.text, /\/Users\//, 'no absolute path')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('token · rotation invalidates the previous value', async () => {
  const registry = createTokenRegistry()
  const first = registry.current()
  registry.rotate()
  assert.notEqual(registry.current(), first, 'a restart/rotation issues a new token')
  assert.equal(sameToken(first, registry.current()), false)
})

test('token · sameToken compares length first and never throws', () => {
  const token = 'a'.repeat(64)
  assert.equal(sameToken(token, token), true)
  assert.equal(sameToken(token, token.slice(0, -1)), false, 'a shorter candidate is just false')
  assert.equal(sameToken(token, 'b'.repeat(64)), false)
  assert.equal(sameToken(undefined, token), false)
  assert.equal(sameToken(token, 42), false, 'a non-string is false, not a TypeError')
})

test('token · the delete route is NOT registered unless the token endpoint is live', async () => {
  const { registerArchiveRoutes } = await import('../src/host/features/archive/route-guard.js')
  const registered = []
  const webServer = { register: (route) => { registered.push(route); return () => {} } }
  const base = { webServer, token: 'x'.repeat(64), origins: [ORIGIN], onDelete: () => ({ ok: true }) }

  assert.equal(registerArchiveRoutes(base).registered, false, 'disabled by default')
  assert.equal(registerArchiveRoutes({ ...base, enabled: true }).registered, true)
  assert.equal(registered.length, 1)
})
