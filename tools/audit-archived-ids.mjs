/**
 * Audit the REAL archive state against the delete allowlist.
 *
 * Pi's point: scanning session DIRECTORY names proves nothing about the ids the
 * delete route actually receives. Those come from `global.archivedSessionIds` in
 * `<home>/storages/workspace.json`, which also contains ids whose directory was
 * physically removed long ago ("ghosts") and may mix the bare and `session-`
 * spellings.
 *
 * Usage: node tools/audit-archived-ids.mjs [--home <dir>]
 */

import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isSafeSessionId } from '../src/host/features/archive/paths.js'

const argv = process.argv.slice(2)
const homeIndex = argv.indexOf('--home')
const home = homeIndex >= 0 ? argv[homeIndex + 1] : process.env.DSH_HOME || join(homedir(), '.dsh')

function readArchived(home) {
  const workspaceFile = join(home, 'storages', 'workspace.json')
  const parsed = JSON.parse(readFileSync(workspaceFile, 'utf8'))
  const ids = parsed?.global?.archivedSessionIds
  return Array.isArray(ids) ? ids : []
}

function listSessionDirs(home) {
  const root = join(home, 'sessions')
  const names = new Set()
  for (const project of readdirSync(root)) {
    let segments
    try {
      segments = readdirSync(join(root, project))
    } catch (error) {
      continue
    }
    for (const segment of segments) names.add(segment)
  }
  return names
}

const ids = readArchived(home)
const dirs = listSessionDirs(home)

const invalid = []
const ghosts = []
const spellings = new Map()
const canonical = new Map()

for (const raw of ids) {
  const id = String(raw)
  const bare = id.replace(/^session-/, '')
  const safe = isSafeSessionId(id)
  if (!safe) invalid.push(id)
  const hasDir = dirs.has(id) || dirs.has(bare)
  if (safe && !hasDir) ghosts.push(id)
  const shape = id.startsWith('session-') ? 'session-uuid' : /^[0-9a-f-]{36}$/.test(id) ? 'bare-uuid' : 'other'
  spellings.set(shape, (spellings.get(shape) || 0) + 1)
  canonical.set(bare, (canonical.get(bare) || 0) + 1)
}

const duplicates = [...canonical.entries()].filter(([, count]) => count > 1)

console.log('')
console.log('=== real archive audit ===')
console.log('  home              : ' + home)
console.log('  archived ids      : ' + ids.length)
console.log('  session dirs      : ' + dirs.size)
console.log('  invalid shape     : ' + invalid.length + (invalid.length ? '  <-- these could never be deleted' : ''))
for (const id of invalid) console.log('      ! ' + id)
console.log('  ghosts (no dir)   : ' + ghosts.length + '  <-- cleanup-only must handle these')
for (const id of ghosts.slice(0, 10)) console.log('      ~ ' + id)
console.log('  spellings         : ' + [...spellings.entries()].map(([k, v]) => k + '=' + v).join(' · '))
console.log('  canonical dups    : ' + duplicates.length + (duplicates.length ? '  <-- bare/session- mix' : ''))
for (const [key, count] of duplicates.slice(0, 10)) console.log('      ! ' + key + ' x' + count)
console.log('')

// Exit code is informational: ghosts are normal, invalid shapes are not.
process.exit(invalid.length === 0 ? 0 : 1)
