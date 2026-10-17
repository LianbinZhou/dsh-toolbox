/**
 * Client build: src/client/index.js -> client.js (one IIFE, committed).
 *
 * Three rules that are not optional (see the v2 review, P0-2):
 *
 * 1. No file may `import react`. React arrives through the module loader's
 *    own `require` and is handed to `installRuntime`. Importing it here would
 *    either bundle a SECOND React or emit a top-level `__require("react")`,
 *    which throws in the browser bundle.
 * 2. The loader entry must call `window.__ModuleLoader__.load({ id, factory })`.
 *    A bare IIFE registers nothing and the host never loads the module.
 * 3. The esbuild version is pinned in package.json (exact, no caret) because
 *    `build-fresh.test.mjs` compares the committed artifact byte for byte.
 */

import { build } from 'esbuild'

await build({
  entryPoints: ['src/client/index.js'],
  outfile: 'client.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  minify: false,
  legalComments: 'none',
  sourcemap: false,
  charset: 'utf8',
  logLevel: 'info',
})
