/**
 * S4-c · generate the typert artifacts WITHOUT replacing the build chain.
 *
 * The generator ships as a tsdown (rolldown) plugin, but it also exports its
 * engine (`WorkspaceTypertGenerator`) and the writer (`writePackageArtifacts`).
 * Calling those directly keeps esbuild — and `build-fresh`'s byte comparison —
 * exactly as they are.
 *
 * The script is deliberately paranoid: it PRINTS what the generator API looks
 * like instead of assuming it, because this is an internal API of a pinned
 * package (0.2.1-alpha.4). If a future DSH changes the signature, this must fail
 * loudly rather than silently emit nothing.
 *
 * Usage: node tools/typert-build.mjs [--write]
 */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const write = process.argv.includes('--write')

const generator = await import('@deepseek-ai/dsh-typert-generator')

console.log('')
console.log('=== typert generator probe ===')
console.log('  version : ' + (await readVersion()))
console.log('  exports : ' + Object.keys(generator).sort().join(', '))

const Ctor = generator.WorkspaceTypertGenerator
if (typeof Ctor !== 'function') {
  fail('WorkspaceTypertGenerator is not a constructor in this version')
}

console.log('  ctor args: ' + (Ctor.length >= 0 ? String(Ctor.length) : '?'))
const proto = Ctor.prototype || {}
console.log('  methods  : ' + Object.keys(proto).sort().join(', '))

/**
 * Instantiate it the way the tsdown plugin does: `{ root, options }`.
 * The plugin builds `generateInWorker({ root, faces?, options: {checkDiagnostics:false} })`,
 * so we mirror that shape.
 */
let instance
try {
  // The constructor is POSITIONAL (arity 1): the workspace root is the argument,
  // not an options object. `new Ctor({root})` makes it call path.resolve(object).
  instance = Ctor.length >= 2
    ? new Ctor(root, { checkDiagnostics: false })
    : new Ctor(root)
} catch (error) {
  fail('constructor rejected (root): ' + (error && (error.stack || error.message)))
}

const runnable = ['generate', 'run', 'generateAll', 'emit'].find((name) => typeof instance[name] === 'function')
if (!runnable) {
  fail('no generation method found on the instance; keys = ' + Object.keys(instance).join(', '))
}
console.log('  runner   : ' + runnable + '()')

let artifacts
try {
  artifacts = await instance[runnable]()
} catch (error) {
  fail(runnable + '() threw: ' + (error && (error.stack || error.message)))
}

if (!Array.isArray(artifacts)) {
  console.log('  result   : ' + typeof artifacts + ' (not an array)')
  console.log('  keys     : ' + (artifacts && Object.keys(artifacts).join(', ')))
  fail('the generator did not return an artifact array')
}

console.log('')
console.log('  artifacts: ' + artifacts.length)
for (const artifact of artifacts) {
  console.log('    - face=' + artifact.face + ' packageRoot=' + artifact.packageRoot + ' remote=' + (artifact.remote !== undefined))
}

if (!write) {
  console.log('')
  console.log('  dry run: pass --write to emit lib/typert.*')
  process.exit(0)
}

// Only this package's artifacts; the workspace writer would write every package.
const mine = artifacts.filter((artifact) => String(artifact.packageRoot).includes('dsh-toolbox'))
if (mine.length === 0) {
  fail('no artifact for this package — does package.json export ./typert?')
}
generator.writePackageArtifacts(root, mine)
console.log('')
console.log('  wrote ' + mine.length + ' artifact(s) into lib/')

async function readVersion() {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  return require('@deepseek-ai/dsh-typert-generator/package.json').version
}

function fail(message) {
  console.error('')
  console.error('=== typert-build FAILED ===')
  console.error('  ' + message)
  console.error('')
  process.exit(1)
}
