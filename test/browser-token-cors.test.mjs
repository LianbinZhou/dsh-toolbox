/**
 * S4-c · the token endpoint in a REAL browser.
 *
 * Node's fetch does not implement CORS, so only a browser can answer "can a
 * foreign page read the token?". The two facts that matter:
 *
 *   - a cross-origin `fetch` cannot read the body (no Access-Control-Allow-Origin),
 *   - the same-origin page can, because that is the whole point of the route.
 *
 * A `<script>`, `<img>` and `<form>` are fired at the endpoint too: they must not
 * produce side effects (the route is GET-only and idempotent).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { TOKEN_PATH, createTokenEndpoint, createTokenRegistry } from '../src/host/features/archive/token-route.js'

let playwright = null
try {
  playwright = await import('playwright')
} catch (error) {
  playwright = null
}

const SKIP = playwright === null
  ? 'Playwright 未安装：npm i -D playwright && npx playwright install chromium'
  : false

const TOKEN = 'k'.repeat(64)

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('browser · a foreign page cannot read the token body', { skip: SKIP }, async () => {
  const registry = createTokenRegistry(TOKEN)
  const target = await listen(createTokenEndpoint({ registry, origins: [] }))
  const targetUrl = 'http://127.0.0.1:' + target.port + TOKEN_PATH

  // The attacker is served from a DIFFERENT port => a different origin.
  const attacker = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<!doctype html><meta charset="utf-8"><body><script>' +
        'window.__r = {};' +
        'window.__go = async () => {' +
        '  try { const res = await fetch(' + JSON.stringify(targetUrl) + ", { mode: 'cors' });" +
        '    window.__r.status = res.status; window.__r.body = await res.text(); window.__r.read = true;' +
        '  } catch (error) { window.__r.error = String(error); window.__r.read = false; }' +
        '  const img = new Image(); img.src = ' + JSON.stringify(targetUrl) + ';' +
        '};' +
        '</script></body>',
    )
  })
  const attackerUrl = 'http://127.0.0.1:' + attacker.port + '/'

  const browser = await playwright.chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(attackerUrl)
    await page.evaluate(() => window.__go())
    await page.waitForTimeout(300)
    const result = await page.evaluate(() => window.__r)

    assert.equal(result.read, false, 'a cross-origin fetch must not be able to read the body')
    assert.equal(result.body, undefined, 'no token text reached the attacker')
    assert.ok(result.error, 'the browser blocked it: ' + JSON.stringify(result))
  } finally {
    await browser.close()
    await new Promise((resolve) => attacker.server.close(resolve))
    await new Promise((resolve) => target.server.close(resolve))
  }
})

test('browser · the same-origin page CAN read it (that is the feature)', { skip: SKIP }, async () => {
  const registry = createTokenRegistry(TOKEN)
  let pageHtml = ''
  const endpoint = createTokenEndpoint({ registry, origins: [] })
  const target = await listen((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(pageHtml)
      return
    }
    endpoint(req, res)
  })
  pageHtml =
    '<!doctype html><meta charset="utf-8"><body><script>' +
    'window.__r = {};' +
    '(' + 'async () => {' +
    '  const res = await fetch(' + JSON.stringify(TOKEN_PATH) + ');' +
    '  window.__r.status = res.status;' +
    '  window.__r.token = (await res.json()).token;' +
    '})();' +
    '</script></body>'

  const browser = await playwright.chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto('http://127.0.0.1:' + target.port + '/')
    await page.waitForFunction(() => window.__r && window.__r.token !== undefined, undefined, { timeout: 5000 })
    const result = await page.evaluate(() => window.__r)
    assert.equal(result.status, 200)
    assert.equal(result.token, TOKEN, 'the same-origin page receives the real token')
  } finally {
    await browser.close()
    await new Promise((resolve) => target.server.close(resolve))
  }
})