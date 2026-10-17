/**
 * The defendant: the PRE-S4-b archive route, reproduced faithfully.
 *
 * Copied from `dsh-plugins/dsh-archive-manager/src/host/index.js` (the
 * `webServer.register` routes). Every missing check is annotated; they are exactly
 * what Pi's R0 red line forbids.
 *
 * It is a REAL node:http server so the attack matrix fires real requests at it,
 * including the "simple request" shapes a malicious page can send without a
 * CORS preflight.
 */

import { createServer } from 'node:http'

/**
 * @param {(sessionId: string) => void} onDelete - records what the attacker managed to delete
 * @returns {import('node:http').Server}
 */
export function createLegacyServer(onDelete = () => {}) {
  return createServer((req, res) => {
    // FLAW R6: no method check. GET / PUT / DELETE all reach the handler.
    // FLAW R0: no peer check. A LAN client reaches this as easily as localhost.
    // FLAW R0: no Origin / Sec-Fetch-Site check, so a malicious page's simple
    //          POST is indistinguishable from the real UI.
    // FLAW R0: no Content-Type requirement: `text/plain` avoids the preflight.
    // FLAW R6: no body size cap: the whole thing is buffered into a string.
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body || '{}')
      } catch (error) {
        // FLAW R6: a malformed body is not an error, it just becomes "no id".
        parsed = {}
      }
      try {
        onDelete(parsed && parsed.sessionId)
      } catch (error) {
        /* the old handler reported failures through the route result only */
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, removedDir: true }))
    })
  })
}
