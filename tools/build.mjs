/**
 * Client build: src/client/index.js -> client.js (one IIFE, committed).
 *
 * Rules that are not optional (v2 review P0-2):
 *   - no file imports react; it arrives through the loader's own require;
 *   - the loader entry must call `window.__ModuleLoader__.load({ id, factory })`;
 *   - esbuild is pinned exactly, because `build-fresh.test.mjs` compares bytes.
 *
 * The build is also importable: `buildOnce({ write: false })` returns the bytes
 * without touching the committed artifact, which is how the freshness test
 * compares without leaving a dirty working tree.
 */

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

export const ENTRY = 'src/client/index.js'
export const OUTFILE = 'client.js'

/**
 * Build the client bundle.
 * @param {{ write?: boolean }} options - write=false returns the bytes instead
 * @returns the esbuild result, with `text` when write is false
 */
export async function buildOnce(options = {}) {
  const { write = true } = options
  const result = await build({
    absWorkingDir: root,
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110'],
    minify: false,
    legalComments: 'none',
    sourcemap: false,
    charset: 'utf8',
    write,
    logLevel: write ? 'info' : 'silent',
  })
  if (!write && result.outputFiles && result.outputFiles[0]) {
    return { text: result.outputFiles[0].text }
  }
  return result
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]

if (invokedDirectly) {
  await buildOnce({ write: true })
}
