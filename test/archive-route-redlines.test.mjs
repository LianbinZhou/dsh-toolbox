/**
 * S4-b · R0/R6 — the attack matrix over a real socket, against the guarded
 * handler, plus the checks that a real HTTP socket cannot produce.
 *
 * Pi's follow-up added three P0s:
 *   P0-1 Host allowlist (DNS rebinding)   -> R0-Host in the matrix + unit tests
 *   P0-2 loopback is not authentication   -> X-Forwarded-For unit tests
 *   P0-3 a constant header is not a token -> R0-token-* in the matrix
 * and three P1s:
 *   P1-5 error messages must not leak paths
 *   P1-6 the SAME handler must be what the host registers (integration test)
 *   P1-7 compare full origins, not just hosts
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { ROUTE_CASES, runRouteMatrix, DELETE_PATH, VALID_ID, fireRaw } from './support/route-attack.mjs'
import {
  CSRF_HEADER,
  MAX_BODY_BYTES,
  TOKEN_HEADER,
  createArchiveServer,
  createRouteGuard,
  createRouteToken,
  isJsonContentType,
  isLoopbackPeer,
  normalizeOrigin,
  registerArchiveRoutes,
} from '../src/host/features/archive/route-guard.js'

const TOKEN = createRouteToken()

function guardedSetup(options = {}) {
  return (onDelete) => ({
    server: createArchiveServer({ onDelete, token: options.token || TOKEN, extraPorts: options.extraPorts }),
    token: options.token || TOKEN,
  })
}

for (const item of ROUTE_CASES) {
  test(item.id + ' · ' + item.title, async (t) => {
    if (item.skip) {
      t.skip(item.skip)
      return
    }
    const summary = await runRouteMatrix(guardedSetup())
    const result = summary.results.find((r) => r.id === item.id)
    assert.equal(result.ok, true, result.error || 'case failed')
  })
}

/* --------------------------- P0-1 Host allowlist --------------------------- */

test('P0-1 · a Host we do not listen on is refused even with a valid token', async () => {
  const summary = await runRouteMatrix(guardedSetup())
  const result = summary.results.find((r) => r.id === 'R0-Host')
  assert.equal(result.ok, true, result.error || 'the forged Host case must pass')
})

test('P0-1 · the guard refuses everything when it has no origins', () => {
  const guard = createRouteGuard({ allowedOrigins: [], token: TOKEN })
  const decision = guard.authorize({
    method: 'POST',
    peer: '127.0.0.1',
    headers: {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'content-type': 'application/json',
      [CSRF_HEADER]: '1',
      [TOKEN_HEADER]: TOKEN,
    },
  })
  assert.equal(decision.ok, false)
  assert.equal(decision.status, 403)
  assert.equal(decision.code, 'no allowed origins configured')
})

/* ------------------- P0-2 loopback is not authentication ------------------- */

test('P0-2 · a proxied request is refused even when the peer looks loopback', () => {
  const guard = createRouteGuard({ allowedOrigins: ['http://127.0.0.1:3080'], token: TOKEN })
  const headers = {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    'content-type': 'application/json',
    [CSRF_HEADER]: '1',
    [TOKEN_HEADER]: TOKEN,
    'x-forwarded-for': '203.0.113.5',
  }
  const decision = guard.authorize({ method: 'POST', peer: '127.0.0.1', headers })
  assert.equal(decision.ok, false, 'a reverse proxy makes every remote request look local')
  assert.equal(decision.status, 403)
  assert.equal(decision.code, 'proxied request refused')
})

test('P0-2 · Forwarded / X-Real-IP are refused too', () => {
  const guard = createRouteGuard({ allowedOrigins: ['http://127.0.0.1:3080'], token: TOKEN })
  for (const name of ['forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto']) {
    const headers = {
      host: '127.0.0.1:3080',
      'content-type': 'application/json',
      [CSRF_HEADER]: '1',
      [TOKEN_HEADER]: TOKEN,
      [name]: 'something',
    }
    const decision = guard.authorize({ method: 'POST', peer: '127.0.0.1', headers })
    assert.equal(decision.ok, false, name + ' must be refused')
  }
})

test('P0-2 · a non-loopback peer is refused', () => {
  for (const peer of [undefined, '', '10.0.0.1', '192.168.1.50', '127.0.0.1.evil']) {
    assert.equal(isLoopbackPeer(peer), false, String(peer) + ' is not loopback')
  }
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackPeer(peer), true, peer + ' is loopback')
  }
})

/* --------------------- P0-3 a constant header is not a token --------------- */

test('P0-3 · a missing or short token fails closed', () => {
  for (const token of [undefined, '', 'short', 'x'.repeat(31)]) {
    const guard = createRouteGuard({ allowedOrigins: ['http://127.0.0.1:3080'], token })
    const decision = guard.authorize({
      method: 'POST',
      peer: '127.0.0.1',
      headers: {
        host: '127.0.0.1:3080',
        'content-type': 'application/json',
        [CSRF_HEADER]: '1',
        [TOKEN_HEADER]: token || '',
      },
    })
    assert.equal(decision.ok, false, 'token ' + String(token) + ' must not authenticate')
    assert.equal(decision.status, 401)
  }
})

test('P0-3 · the guard owns a 32-byte token and compares it exactly', () => {
  assert.equal(createRouteToken().length, 64, '32 random bytes as hex')
  const guard = createRouteGuard({ allowedOrigins: ['http://127.0.0.1:3080'], token: TOKEN })
  const base = {
    host: '127.0.0.1:3080',
    'content-type': 'application/json',
    [CSRF_HEADER]: '1',
  }
  assert.equal(guard.authorize({ method: 'POST', peer: '127.0.0.1', headers: { ...base, [TOKEN_HEADER]: TOKEN } }).ok, true)
  assert.equal(guard.authorize({ method: 'POST', peer: '127.0.0.1', headers: { ...base, [TOKEN_HEADER]: TOKEN.slice(0, -1) } }).ok, false)
  assert.equal(guard.authorize({ method: 'POST', peer: '127.0.0.1', headers: { ...base, [TOKEN_HEADER]: TOKEN + 'x' } }).ok, false)
})

/* --------------------------- P1-7 full origins ---------------------------- */

test('P1-7 · origins are compared as scheme + host + port', () => {
  const guard = createRouteGuard({ allowedOrigins: ['http://127.0.0.1:3080'], token: TOKEN })
  const headers = {
    host: '127.0.0.1:3080',
    'content-type': 'application/json',
    [CSRF_HEADER]: '1',
    [TOKEN_HEADER]: TOKEN,
  }
  const ok = guard.authorize({ method: 'POST', peer: '127.0.0.1', headers: { ...headers, origin: 'http://127.0.0.1:3080' } })
  assert.equal(ok.ok, true)

  for (const origin of ['https://127.0.0.1:3080', 'http://127.0.0.1:9999', 'http://localhost:3080', 'null']) {
    const refused = guard.authorize({ method: 'POST', peer: '127.0.0.1', headers: { ...headers, origin } })
    assert.equal(refused.ok, false, origin + ' is a different origin')
    assert.equal(refused.status, 403)
  }
  assert.equal(normalizeOrigin('http://127.0.0.1:3080/some/path'), 'http://127.0.0.1:3080', 'paths are dropped')
  assert.equal(normalizeOrigin('not a url'), null)
})

/* ------------------------- P1-5 error sanitisation ------------------------ */

test('P1-5 · a service error message never reaches the client', async () => {
  const leaky = 'C:\\Users\\zhou0\\.dsh\\sessions\\secret\\session-aaaa'
  const server = createArchiveServer({
    token: TOKEN,
    onDelete: () => ({ ok: false, error: leaky, warning: '/Users/zhou0/.dsh/private' }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const res = await fireRaw({
      port,
      method: 'POST',
      path: DELETE_PATH,
      headers: {
        host: '127.0.0.1:' + port,
        origin: 'http://127.0.0.1:' + port,
        'content-type': 'application/json',
        [CSRF_HEADER]: '1',
        [TOKEN_HEADER]: TOKEN,
      },
      body: JSON.stringify({ sessionId: VALID_ID }),
    })
    assert.equal(res.status, 409, 'a refused delete is a conflict')
    assert.doesNotMatch(res.text, /Users/, 'no absolute path in the body')
    assert.doesNotMatch(res.text, /:\\\\/, 'no drive letter in the body')
    assert.equal(res.json.error, 'delete refused', 'only a whitelisted code')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('P1-5 · a warning is reduced to a fixed phrase', async () => {
  const server = createArchiveServer({
    token: TOKEN,
    onDelete: () => ({ ok: true, removedDir: true, warning: 'C:\\secret\\path failed' }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const res = await fireRaw({
      port,
      method: 'POST',
      path: DELETE_PATH,
      headers: {
        host: '127.0.0.1:' + port,
        origin: 'http://127.0.0.1:' + port,
        'content-type': 'application/json',
        [CSRF_HEADER]: '1',
        [TOKEN_HEADER]: TOKEN,
      },
      body: JSON.stringify({ sessionId: VALID_ID }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.warning, 'deleted with warnings')
    assert.doesNotMatch(res.text, /secret/, 'the original message is gone')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

/* ------------------- P1-6 the HOST-mounted route is tested ---------------- */

/** Serve the captured route on a real server, exactly like the host would. */
async function serveCapturedRegistration(registerOptions) {
  let handler = null
  let closed = false
  const server = createServer((req, res) => {
    if (handler === null) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"ok":false,"error":"not found"}')
      return
    }
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const webServer = {
    register(route) {
      handler = route.handler
      return () => {
        handler = null
        closed = true
      }
    },
  }
  const registration = registerArchiveRoutes({
    webServer,
    token: registerOptions.token,
    origins: registerOptions.origins ?? ['http://127.0.0.1:' + port, 'http://localhost:' + port],
    onDelete: registerOptions.onDelete,
  })
  return { server, port, registration, isClosed: () => closed }
}

test('P1-6 · the route the host actually registers enforces the guard', async () => {
  const deleted = []
  const mounted = await serveCapturedRegistration({ token: TOKEN, onDelete: (id) => { deleted.push(id); return { ok: true, removedDir: true } } })
  try {
    assert.equal(mounted.registration.registered, true)

    // No credential -> refused, and the handler never runs.
    const naked = await fireRaw({
      port: mounted.port,
      method: 'POST',
      path: DELETE_PATH,
      headers: { host: '127.0.0.1:' + mounted.port, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: VALID_ID }),
    })
    assert.equal(naked.status, 401, 'the mounted route must run the same guard, got ' + naked.status)
    assert.equal(deleted.length, 0)

    // Credential present -> works.
    const legit = await fireRaw({
      port: mounted.port,
      method: 'POST',
      path: DELETE_PATH,
      headers: {
        host: '127.0.0.1:' + mounted.port,
        origin: 'http://127.0.0.1:' + mounted.port,
        'content-type': 'application/json',
        [CSRF_HEADER]: '1',
        [TOKEN_HEADER]: TOKEN,
      },
      body: JSON.stringify({ sessionId: VALID_ID }),
    })
    assert.equal(legit.status, 200)
    assert.deepEqual(deleted, [VALID_ID])
  } finally {
    if (mounted.registration.dispose) mounted.registration.dispose()
    await new Promise((resolve) => mounted.server.close(resolve))
  }
})

test('P1-6 · registration fails closed without a token or origins', async () => {
  const captured = []
  const webServer = { register: (route) => { captured.push(route); return () => {} } }

  const noToken = registerArchiveRoutes({ webServer, token: '', origins: ['http://127.0.0.1:3080'] })
  assert.equal(noToken.registered, false)
  assert.match(noToken.reason, /token/)

  const noOrigins = registerArchiveRoutes({ webServer, token: TOKEN, origins: [] })
  assert.equal(noOrigins.registered, false)
  assert.match(noOrigins.reason, /origins/)

  const noServer = registerArchiveRoutes({ webServer: null, token: TOKEN, origins: ['http://127.0.0.1:3080'] })
  assert.equal(noServer.registered, false)

  assert.equal(captured.length, 0, 'nothing may be registered when the guard cannot be built')
})

/* ------------------------------ P2 edges --------------------------------- */

test('P2 · an oversized declared Content-Length is refused without reading', () => {
  const guard = createRouteGuard({ allowedOrigins: ['http://127.0.0.1:3080'], token: TOKEN })
  const decision = guard.authorize({
    method: 'POST',
    peer: '127.0.0.1',
    headers: {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'content-type': 'application/json',
      [CSRF_HEADER]: '1',
      [TOKEN_HEADER]: TOKEN,
      'content-length': String(MAX_BODY_BYTES + 1),
    },
  })
  assert.equal(decision.ok, false)
  assert.equal(decision.status, 413)
})

test('P2 · only JSON content types are accepted', () => {
  assert.equal(isJsonContentType('application/json'), true)
  assert.equal(isJsonContentType('application/json; charset=utf-8'), true)
  assert.equal(isJsonContentType('text/plain'), false)
  assert.equal(isJsonContentType(undefined), false)
})
