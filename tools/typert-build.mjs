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

// Fail loud: "0 artifacts" must never look like success.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
const required = ['lib/typert.host.js', 'lib/typert.host.d.ts', 'lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts']
for (const rel of required) {
  const file = join(root, rel)
  try {
    const stat = statSync(file)
    if (stat.size === 0) fail(rel + ' was written EMPTY')
    if (rel.endsWith('.js')) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes('echo')) fail(rel + ' does not mention echo — the method never reached the table')
      if (!text.includes('Remote')) fail(rel + ' carries no Remote metadata')
    }
    console.log('  ok  ' + rel + '  ' + stat.size + ' B')
  } catch (error) {
    fail(rel + ' is missing after generation: ' + error.message)
  }
}
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
