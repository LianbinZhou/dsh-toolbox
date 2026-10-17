/**
 * S4-b · R0 / R6 attack matrix over a REAL HTTP socket.
 *
 * Every case fires an actual request and asserts the SECURE expectation. Run
 * against the pre-S4-b route it should be a wall of red: the old handler answers
 * 200 to every one of them, including the shapes a malicious web page can send
 * without a preflight.
 *
 * The peer-address case cannot be produced over a loopback socket, so it is
 * covered by the guard's unit tests; the matrix records it as skipped here.
 */

import assert from 'node:assert/strict'

const DELETE_PATH = '/api/archive-manager/delete'
const VALID_ID = 'session-aaaaaaaa-1111-2222-3333-444444444444'

/** Start one server on an ephemeral loopback port. */
async function start(createServer) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return { server, port, origin: 'http://127.0.0.1:' + port }
}

async function stop(server) {
  await new Promise((resolve) => server.close(resolve))
}

/**
 * Fire one request and return its status + headers + parsed body.
 * @param {string} url
 * @param {object} init - fetch init plus an optional `raw` body string
 */
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

const JSON_HEADERS = { 'content-type': 'application/json' }

/** Every case: `run({ origin, deleted, fire })` must throw on an insecure answer. */
export const ROUTE_CASES = [
  {
    id: 'R0-a',
    title: 'a cross-origin POST (Origin: evil.example) is refused',
    async run(ctx) {
      const res = await ctx.fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: { ...JSON_HEADERS, origin: 'http://evil.example' },
        body: JSON.stringify({ sessionId: VALID_ID }),
      })
      assert.equal(res.status, 403, 'a foreign Origin must not reach the delete handler, got ' + res.status)
      assert.equal(ctx.deletedCount(), 0, 'nothing may be deleted')
    },
  },
  {
    id: 'R0-b',
    title: 'a simple request without Origin and without the custom header is refused (CSRF)',
    async run(ctx) {
      const res = await ctx.fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ sessionId: VALID_ID }),
      })
      assert.equal(res.status, 403, 'a browser-form style POST must be refused, got ' + res.status)
      assert.equal(ctx.deletedCount(), 0)
    },
  },
  {
    id: 'R0-c',
    title: 'a text/plain body (no preflight) is refused',
    async run(ctx) {
      const res = await ctx.fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'x-dsh-toolbox': '1', origin: ctx.origin },
        body: JSON.stringify({ sessionId: VALID_ID }),
      })
      assert.equal(res.status, 415, 'text/plain would bypass CORS preflight, got ' + res.status)
      assert.equal(ctx.deletedCount(), 0)
    },
  },
  {
    id: 'R0-d',
    title: 'a missing Content-Type is refused',
    async run(ctx) {
      const res = await ctx.fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: { 'x-dsh-toolbox': '1', origin: ctx.origin },
        body: JSON.stringify({ sessionId: VALID_ID }),
      })
      assert.equal(res.status, 415, 'the body type must be stated, got ' + res.status)
      assert.equal(ctx.deletedCount(), 0)
    },
  },
  {
    id: 'R0-e',
    title: 'a non-loopback peer is refused',
    skip: 'cannot be produced over a loopback socket; covered by route-guard unit tests',
  },
  {
    id: 'R6-a',
    title: 'GET is 405',
    async run(ctx) {
      const res = await ctx.fire(ctx.origin + DELETE_PATH, { method: 'GET', headers: { 'x-dsh-toolbox': '1' } })
      assert.equal(res.status, 405, 'only POST deletes, got ' + res.status)
    },
  },
  {
    id: 'R6-b',
    title: 'DELETE is 405',
    async run(ctx) {
      const res = await ctx.fire(ctx.origin + DELETE_PATH, { method: 'DELETE', headers: { 'x-dsh-toolbox': '1' } })
      assert.equal(res.status, 405, 'only POST deletes, got ' + res.status)
    },
  },
  {
    id: 'R6-c',
    title: 'OPTIONS answers 204 without permissive CORS headers',
    async run(ctx) {
      const res = await ctx.fire(ctx.origin + DELETE_PATH, {
        method: 'OPTIONS',
        headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
      })
      assert.ok(res.status === 204 || res.status === 405, 'OPTIONS must not expose the route, got ' + res.status)
      assert.equal(res.headers.get('access-control-allow-origin'), null, 'no wildcard CORS')
    },
  },
  {
    id: 'R6-d',
    title: 'an oversized body is refused',
    async run(ctx) {
      const huge = JSON.stringify({ sessionId: VALID_ID, pad: 'x'.repeat(80 * 1024) })
      const res = await ctx.fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'x-dsh-toolbox': '1', origin: ctx.origin },
        body: huge,
      })
      assert.ok(res.status === 413 || res.status === 400, 'a body over the cap must be refused, got ' + res.status)
      assert.equal(ctx.deletedCount(), 0)
    },
  },
  {
    id: 'R6-e',
    title: 'malformed JSON is 400',
    async run(ctx) {
      const res = await ctx.fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'x-dsh-toolbox': '1', origin: ctx.origin },
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
      for (const body of ['{}', '{"sessionId":42}', '{"sessionId":null}', '[]', '"just a string"']) {
        const res = await ctx.fire(ctx.origin + DELETE_PATH, {
          method: 'POST',
          headers: { ...JSON_HEADERS, 'x-dsh-toolbox': '1', origin: ctx.origin },
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
      const res = await ctx.fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'x-dsh-toolbox': '1', origin: ctx.origin },
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
      const res = await ctx.fire(ctx.origin + DELETE_PATH, {
        method: 'POST',
        headers: { ...JSON_HEADERS, origin: 'http://evil.example' },
        body: JSON.stringify({ sessionId: VALID_ID }),
      })
      assert.doesNotMatch(res.text, /[A-Za-z]:\\\\/, 'no drive letter in the response')
      assert.doesNotMatch(res.text, /\/Users\//, 'no absolute unix path in the response')
    },
  },
]

/**
 * Run the matrix against one server factory.
 * @param {() => import('node:http').Server} createServer
 * @returns {Promise<{results: Array, passed: number, failed: number}>}
 */
export async function runRouteMatrix(createServer) {
  const results = []
  for (const item of ROUTE_CASES) {
    if (item.skip) {
      results.push({ id: item.id, title: item.title, ok: true, skipped: true })
      continue
    }
    const deleted = []
    let handle
    try {
      handle = await start(() => createServer((id) => deleted.push(id)))
      const ctx = {
        origin: handle.origin,
        fire,
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
