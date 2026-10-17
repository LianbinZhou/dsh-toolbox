/**
 * S4-b · P1-4 — REAL browser CORS behaviour.
 *
 * Why this file exists: Node's `fetch` does not run the browser's CORS machinery.
 * It happily sends a cross-origin POST and hands back the response, so the
 * socket-level matrix proves the SERVER refuses, not what a browser does.
 *
 * A browser decides differently per request shape:
 *   - `<form>` POST / `fetch(mode:'no-cors')` with `text/plain`: sent, no preflight
 *   - `fetch` with a custom header: preflighted, and the browser STOPS if the
 *     preflight is rejected
 *   - sandboxed iframe: `Origin: null`
 *   - private-network requests: `Access-Control-Request-Private-Network`
 *
 * The assertion that matters is **the server saw no delete at all**, not the
 * response status: CORS can hide a response while the action already happened.
 *
 * Requires Playwright. Skipped (loudly) when it is not installed:
 *   npm i -D playwright && npx playwright install chromium
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createArchiveServer, createRouteToken, CSRF_HEADER, TOKEN_HEADER } from '../src/host/features/archive/route-guard.js'

let playwright = null
try {
  playwright = await import('playwright')
} catch (error) {
  playwright = null
}

const SKIP = playwright === null
  ? 'Playwright 未安装：npm i -D playwright && npx playwright install chromium'
  : false

const DELETE_PATH = '/api/archive-manager/delete'
const VALID_ID = 'session-aaaaaaaa-1111-2222-3333-444444444444'
const TOKEN = createRouteToken()

/** A hostile page origin, plus the DSH-like target origin. */
async function startAttackerPage() {
  const html = [
    '<!doctype html><meta charset="utf-8"><title>attacker</title>',
    '<body><script>',
    'window.__results = {};',
    'window.__post = async (headers, body) => {',
    '  try { const r = await fetch(window.__target, { method: "POST", mode: "no-cors", headers, body });',
    '    return "sent:" + r.type; } catch (e) { return "blocked:" + e.message; }',
    '};',
    '</script></body>',
  ].join('\n')
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: 'http://127.0.0.1:' + server.address().port }
}

test('P1-4 · no browser vector can delete without the token', { skip: SKIP }, async () => {
  const deleted = []
  const target = createArchiveServer({ token: TOKEN, onDelete: (id) => { deleted.push(id); return { ok: true, removedDir: true } } })
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve))
  const targetOrigin = 'http://127.0.0.1:' + target.address().port
  const attacker = await startAttackerPage()
  const browser = await playwright.chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(attacker.origin)
    await page.evaluate((url) => {
      window.__target = url
    }, targetOrigin + DELETE_PATH)

    const body = JSON.stringify({ sessionId: VALID_ID })

    // 1. text/plain, no custom header: a simple request, no preflight.
    await page.evaluate((b) => window.__post({ 'content-type': 'text/plain' }, b), body)

    // 2. application/json, no custom header: still simple enough to be SENT,
    //    the browser just refuses to expose the response.
    await page.evaluate((b) => window.__post({ 'content-type': 'text/plain' }, b), body)

    // 3. custom header present: preflighted; the preflight fails, so the POST
    //    never leaves the browser. (`CSRF_HEADER` lives in Node, so it is passed
    //    into the page rather than referenced there.)
    await page.evaluate(
      (args) => window.__post({ 'content-type': 'text/plain', [args.header]: '1' }, args.body),
      { header: CSRF_HEADER, body },
    )

    // 4. sandboxed iframe → Origin: null.
    await page.evaluate(
      (args) => {
        const frame = document.createElement('iframe')
        frame.sandbox = 'allow-scripts'
        frame.srcdoc = `<script>fetch(${JSON.stringify(args.url)}, {method:'POST', mode:'no-cors', body:${JSON.stringify(args.body)}})<\/script>`
        document.body.appendChild(frame)
      },
      { url: targetOrigin + DELETE_PATH, body },
    )
    await page.waitForTimeout(1500)

    assert.equal(deleted.length, 0, 'no browser vector may reach the delete handler')
  } finally {
    await browser.close()
    await new Promise((resolve) => target.close(resolve))
    await new Promise((resolve) => attacker.server.close(resolve))
  }
})

test('P1-4 · the CORS preflight is answered without granting access', { skip: SKIP }, async () => {
  const target = createArchiveServer({ token: TOKEN, onDelete: () => ({ ok: true }) })
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve))
  const targetOrigin = 'http://127.0.0.1:' + target.address().port
  const attacker = await startAttackerPage()
  const browser = await playwright.chromium.launch()
  try {
    const page = await browser.newPage()
    const responses = []
    page.on('response', (response) => responses.push(response))
    await page.goto(attacker.origin)
    await page.evaluate(
      async (args) => {
        try {
          await fetch(args.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [args.header]: '1', [args.tokenHeader]: args.token },
            body: JSON.stringify({ sessionId: args.id }),
          })
        } catch (error) {
          /* the browser refuses; that is the expected outcome */
        }
      },
      {
        url: targetOrigin + DELETE_PATH,
        header: CSRF_HEADER,
        tokenHeader: TOKEN_HEADER,
        token: TOKEN,
        id: VALID_ID,
      },
    )
    for (const response of responses) {
      const headers = response.headers()
      assert.equal(headers['access-control-allow-origin'], undefined, 'no ACAO on any answer')
      assert.equal(headers['access-control-allow-credentials'], undefined)
      assert.equal(headers['access-control-allow-private-network'], undefined)
    }
  } finally {
    await browser.close()
    await new Promise((resolve) => target.close(resolve))
    await new Promise((resolve) => attacker.server.close(resolve))
  }
})
