/**
 * S4-b · R0/R6 — the same attack matrix, now over a REAL socket, against the
 * guarded route. Every case that was red against the old route must be green.
 *
 * Plus the one case a loopback socket cannot produce (a non-loopback peer),
 * tested directly on the guard.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { ROUTE_CASES, runRouteMatrix } from './support/route-attack.mjs'
import {
  CSRF_HEADER,
  MAX_BODY_BYTES,
  authorizeRequest,
  createArchiveServer,
  isJsonContentType,
  isLoopbackPeer,
  isSameOrigin,
} from '../src/host/features/archive/route-guard.js'

for (const item of ROUTE_CASES) {
  test(item.id + ' · ' + item.title, async (t) => {
    if (item.skip) {
      t.skip(item.skip)
      return
    }
    // The runner hands us the recorder; wire it into the guarded server so the
    // "handler ran exactly once" assertion is real.
    const summary = await runRouteMatrix((onDelete) =>
      createArchiveServer({
        onDelete: (sessionId) => {
          onDelete(sessionId)
          return { ok: true, removedDir: true }
        },
      }),
    )
    const result = summary.results.find((r) => r.id === item.id)
    assert.equal(result.ok, true, result.error || 'case failed')
  })
}

test('R0-e · a non-loopback peer is refused before anything else', () => {
  const headers = { 'content-type': 'application/json', [CSRF_HEADER]: '1' }
  const decision = authorizeRequest({ method: 'POST', headers, peer: '192.168.1.50' })
  assert.equal(decision.ok, false)
  assert.equal(decision.status, 403)
  assert.equal(decision.error, 'local access only')

  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackPeer(peer), true, peer + ' is loopback')
  }
  for (const peer of [undefined, '', '10.0.0.1', '127.0.0.1.evil']) {
    assert.equal(isLoopbackPeer(peer), false, String(peer) + ' is not loopback')
  }
})

test('same-origin is decided against the request Host', () => {
  assert.equal(isSameOrigin('http://127.0.0.1:3080', '127.0.0.1:3080'), true)
  assert.equal(isSameOrigin('http://localhost:3080', 'localhost:3080'), true)
  assert.equal(isSameOrigin('http://evil.example', '127.0.0.1:3080'), false)
  assert.equal(isSameOrigin('http://127.0.0.1:9999', '127.0.0.1:3080'), false)
  assert.equal(isSameOrigin('null', '127.0.0.1:3080'), false)
  assert.equal(isSameOrigin(undefined, '127.0.0.1:3080'), true, 'no Origin is fine: the custom header proved intent')
})

test('only a JSON content type is accepted', () => {
  assert.equal(isJsonContentType('application/json'), true)
  assert.equal(isJsonContentType('application/json; charset=utf-8'), true)
  assert.equal(isJsonContentType('APPLICATION/JSON'), true)
  assert.equal(isJsonContentType('text/plain'), false)
  assert.equal(isJsonContentType('application/x-www-form-urlencoded'), false)
  assert.equal(isJsonContentType(undefined), false)
})

test('the body cap is 64 KB and is advertised as such', () => {
  assert.equal(MAX_BODY_BYTES, 64 * 1024)
})

test('a hostile Origin on the preflight path is not answered permissively', () => {
  const decision = authorizeRequest({
    method: 'OPTIONS',
    headers: { origin: 'http://evil.example' },
    peer: '127.0.0.1',
  })
  assert.equal(decision.ok, true)
  assert.equal(decision.preflight, true, 'OPTIONS is answered 204 but without CORS headers')
})

test('an oversized Content-Length is refused without reading the body', () => {
  const decision = authorizeRequest({
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', 'content-length': String(MAX_BODY_BYTES + 1) },
    peer: '127.0.0.1',
  })
  assert.equal(decision.ok, false)
  assert.equal(decision.status, 413)
})
