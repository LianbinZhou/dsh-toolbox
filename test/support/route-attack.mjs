/**
 * S4-b · R0 / R6 attack matrix over a REAL HTTP socket.
 *
 * Every case fires an actual request and asserts the SECURE expectation. Run
 * against the pre-S4-b route it is a wall of red; run against the guard it is
 * green.
 *
 * Notes on realism (Pi's P1-4):
 *  - Node's `fetch` does NOT run the browser CORS machinery, so these cases prove
 *    the SERVER refuses, not that a browser would refuse to send. The browser
 *    half lives in `test/browser-cors.test.mjs` (needs Playwright).
 *  - `Host` is a forbidden header in fetch, so the DNS-rebinding case uses a raw
 *    `node:http` request, which is exactly what a rebinding page produces on the
 *    wire.
 */

import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'

const DELETE_PATH = '/api/archive-manager/delete'
const VALID_ID = 'session-aaaaaaaa-1111-2222-3333-444444444444'

async function start(setup) {
  const created = await setup()
  const server = created.server ?? created
  const token = created.token
  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  }
  const { port } = server.address()
  return { server, port, token, origin: 'http://127.0.0.1:' + port }
}

async function stop(server) {
  if (server.listening) await new Promise((resolve) => server.close(resolve))
}

async function fire(url, init = {}) {
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

/**
 * A raw HTTP request, for the header shapes a browser forbids in fetch.
 * @param {{port: number, method: string, path: string, headers: object,
 *          body?: string|string[]}} options
 */
function fireRaw(options) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, options.headers)
    const chunks = options.body === undefined ? [] : Array.isArray(options.body) ? options.body : [options.body]
    if (chunks.length > 0 && headers['content-length'] === undefined) {
      // No content-length: node sends this chunked, like a streamed hostile body.
    }
    const req = httpRequest(
      { host: '127.0.0.1', port: options.port, method: options.method, path: options.path, headers },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => {
          let json
          try {
            json = JSON.parse(text)
          } catch (error) {
            json = undefined
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json })
        })
      },
    )
    req.on('error', reject)
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })
}

const JSON_HEADERS = { 'content-type': 'application/json' }

/** Auth headers a legitimate client sends. */
function legit(ctx, extra = {}) {
  return Object.assign(
    { ...JSON_HEADERS, origin: ctx.origin, 'x-dsh-toolbox': '1', 'x-dsh-toolbox-token': ctx.token },
    extra,
  )
}

export const ROUTE_CASES = [
  {
    id: 'R0-Host',
    title: 'a forged Host + Origin (DNS rebinding) is refused',
    async run(ctx) {
      const res = await fireRaw({
        port: ctx.port,
        method: 'POST',
        path: DELETE_PATH,
        headers: {
          host: 'evil.example',
          origin: 'http://evil.example',
          'content-type': 'application/json',
          'x-dsh-toolbox': '1',
          'x-dsh-toolbox-token': ctx.token,
        },
        body: JSON.stringify({ sessionId: VALID_ID }),
      })
      assert.equal(res.status, 403, 'a Host we do not listen on must be refused, got ' + res.status)
      assert.equal(ctx.deletedCount(), 0, 'nothing may be deleted')
    },
  },
  {
    id: 'R0-a',
    title: 'a cross-origin POST with a VALID token is still refused',
    async run(ctx) {
      const res = await fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: legit(ctx, { origin: 'http://evil.example' }),
        body: JSON.stringify({ sessionId: VALID_ID }),
      })
      assert.equal(res.status, 403, 'the Origin check is independent of the token, got ' + res.status)
      assert.equal(ctx.deletedCount(), 0)
    },
  },
  {
    id: 'R0-b',
    title: 'a simple POST (no Origin, no token) is refused',
    async run(ctx) {
      const res = await fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ sessionId: VALID_ID }),
      })
      assert.ok(res.status === 401 || res.status === 403, 'no credential, no delete, got ' + res.status)
      assert.equal(ctx.deletedCount(), 0)
    },
  },
  {
    id: 'R0-token-missing',
    title: 'the CSRF header alone is not a credential',
    async run(ctx) {
      const res = await fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: { ...JSON_HEADERS, origin: ctx.origin, 'x-dsh-toolbox': '1' },
        body: JSON.stringify({ sessionId: VALID_ID }),
      })
      assert.equal(res.status, 401, 'the constant header proves intent, not identity, got ' + res.status)
      assert.equal(ctx.deletedCount(), 0)
    },
  },
  {
    id: 'R0-token-wrong',
    title: 'a wrong token is refused',
    async run(ctx) {
      const res = await fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: legit(ctx, { 'x-dsh-toolbox-token': 'not-the-token' }),
        body: JSON.stringify({ sessionId: VALID_ID }),
      })
      assert.equal(res.status, 401, 'got ' + res.status)
      assert.equal(ctx.deletedCount(), 0)
    },
  },
  {
    id: 'R0-c',
    title: 'a text/plain body (no preflight) is refused',
    async run(ctx) {
      const res = await fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: legit(ctx, { 'content-type': 'text/plain' }),
        body: JSON.stringify({ sessionId: VALID_ID }),
      })
      assert.equal(res.status, 415, 'text/plain would bypass the CORS preflight, got ' + res.status)
      assert.equal(ctx.deletedCount(), 0)
    },
  },
  {
    id: 'R0-d',
    title: 'a missing Content-Type is refused',
    async run(ctx) {
      const headers = legit(ctx)
      delete headers['content-type']
      const res = await fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: VALID_ID }),
      })
      assert.equal(res.status, 415, 'the body type must be stated, got ' + res.status)
      assert.equal(ctx.deletedCount(), 0)
    },
  },
  {
    id: 'R6-a',
    title: 'GET is 405',
    async run(ctx) {
      const res = await fire(ctx.origin + DELETE_PATH, { method: 'GET', headers: legit(ctx) })
      assert.equal(res.status, 405, 'only POST deletes, got ' + res.status)
    },
  },
  {
    id: 'R6-b',
    title: 'DELETE is 405',
    async run(ctx) {
      const res = await fire(ctx.origin + DELETE_PATH, { method: 'DELETE', headers: legit(ctx) })
      assert.equal(res.status, 405, 'only POST deletes, got ' + res.status)
    },
  },
  {
    id: 'R6-c',
    title: 'OPTIONS answers 204 without permissive CORS headers',
    async run(ctx) {
      const res = await fire(ctx.origin + DELETE_PATH, {
        method: 'OPTIONS',
        headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
      })
      assert.ok(res.status === 204 || res.status === 405, 'OPTIONS must not expose the route, got ' + res.status)
      const allowOrigin = res.headers.get('access-control-allow-origin')
      assert.equal(allowOrigin, null, 'no wildcard CORS')
      assert.equal(res.headers.get('access-control-allow-credentials'), null)
      assert.equal(res.headers.get('access-control-allow-private-network'), null)
    },
  },
  {
    id: 'R6-d',
    title: 'a declared oversized body is refused',
    async run(ctx) {
      const huge = JSON.stringify({ sessionId: VALID_ID, pad: 'x'.repeat(80 * 1024) })
      const res = await fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: legit(ctx),
        body: huge,
      })
      assert.ok(res.status === 413 || res.status === 400, 'a body over the cap must be refused, got ' + res.status)
      assert.equal(ctx.deletedCount(), 0)
    },
  },
  {
    id: 'R0-chunk',
    title: 'a chunked body over the cap is refused (no Content-Length to lie about)',
    async run(ctx) {
      const chunks = []
      for (let i = 0; i < 8; i++) chunks.push(JSON.stringify({ pad: 'x'.repeat(12 * 1024) }))
      const res = await fireRaw({
        port: ctx.port,
        method: 'POST',
        path: DELETE_PATH,
        headers: legit(ctx),
        body: chunks,
      })
      assert.ok(res.status === 413 || res.status === 400, 'a streamed body over the cap must be refused, got ' + res.status)
      assert.equal(ctx.deletedCount(), 0)
    },
  },
  {
    id: 'R6-e',
    title: 'malformed JSON is 400',
    async run(ctx) {
      const res = await fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: legit(ctx),
        body: '{ not json',
      })
      assert.equal(res.status, 400, 'bad JSON is a client error, got ' + res.status)
      assert.equal(ctx.deletedCount(), 0)
    },
  },
  {
    id: 'R6-f',
    title: 'a missing or non-string sessionId is 400',
    async run(ctx) {
      for (const body of ['{}', '{"sessionId":42}', '{"sessionId":null}', '[]', '"just a string"', '{"sessionId":"CON"}']) {
        const res = await fire(ctx.origin + DELETE_PATH, {
          method: 'POST',
          headers: legit(ctx),
          body,
        })
        assert.equal(res.status, 400, 'body ' + body + ' must be refused, got ' + res.status)
      }
      assert.equal(ctx.deletedCount(), 0)
    },
  },
  {
    id: 'R0-f',
    title: 'the legitimate request still works',
    async run(ctx) {
      const res = await fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: legit(ctx),
        body: JSON.stringify({ sessionId: VALID_ID }),
      })
      assert.equal(res.status, 200, 'the real UI must still be able to delete, got ' + res.status)
      assert.equal(ctx.deletedCount(), 1, 'and the handler runs exactly once')
    },
  },
  {
    id: 'R6-g',
    title: 'a refused response leaks no absolute path',
    async run(ctx) {
      const res = await fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: legit(ctx, { origin: 'http://evil.example' }),
        body: JSON.stringify({ sessionId: VALID_ID }),
      })
      assert.doesNotMatch(res.text, /[A-Za-z]:\\\\/, 'no drive letter in the response')
      assert.doesNotMatch(res.text, /\/Users\//, 'no absolute unix path in the response')
    },
  },
]

/**
 * Run the matrix against one server setup.
 * @param {(onDelete: (id: string) => void) => ({server: object, token?: string}|object)} setup
 * @returns {Promise<{results: Array, passed: number, failed: number}>}
 */
export async function runRouteMatrix(setup) {
  const results = []
  for (const item of ROUTE_CASES) {
    if (item.skip) {
      results.push({ id: item.id, title: item.title, ok: true, skipped: true })
      continue
    }
    const deleted = []
    let handle
    try {
      handle = await start(() => setup((id) => deleted.push(id)))
      const ctx = {
        port: handle.port,
        origin: handle.origin,
        token: handle.token,
        fire,
        fireRaw,
        deletedCount: () => deleted.length,
      }
      await item.run(ctx)
      results.push({ id: item.id, title: item.title, ok: true })
    } catch (error) {
      results.push({ id: item.id, title: item.title, ok: false, error: String((error && error.message) || error) })
    } finally {
      if (handle) await stop(handle.server)
    }
  }
  const failed = results.filter((r) => !r.ok)
  return { results, passed: results.length - failed.length, failed: failed.length }
}

export { DELETE_PATH, VALID_ID, fireRaw }
