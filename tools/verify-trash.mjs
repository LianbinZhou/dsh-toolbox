/**
 * S4 真机验证：回收箱与侧栏残留。
 *
 * 用法（重启 DSH 之后）：
 *   node tools/verify-trash.mjs
 *   node tools/verify-trash.mjs --base http://127.0.0.1:3080
 *
 * 只读：不删任何东西。它把「journal / workspace 成员 / projection cache / HTTP 接口」
 * 四处对照一遍，直接回答复审第 7 节的那几条。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const baseIndex = args.indexOf('--base')
const BASE = baseIndex >= 0 ? args[baseIndex + 1] : 'http://127.0.0.1:3080'
const HOME = join(process.env.DSH_HOME || join(homedir(), '.dsh'))

const DAY = 24 * 60 * 60 * 1000
const lines = []
const say = (line = '') => {
  lines.push(line)
  console.log(line)
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return fallback
  }
}

const journal = readJson(join(HOME, 'storages', 'archive', 'archive-journal.json'), { entries: [] })
const workspace = readJson(join(HOME, 'storages', 'workspace.json'), { global: {}, workspaces: {} })
const projcache = readJson(join(HOME, 'storages', 'session_projcache.json'), { tables: {} })

const entries = Array.isArray(journal.entries) ? journal.entries : []
const trashIds = new Set(entries.map((entry) => String(entry.id)))
const bare = (id) => String(id).replace(/^session-/, '')

// 所有 workspace 的 sessionIds 摊平
const workspaceRows = []
for (const [key, entity] of Object.entries(workspace.workspaces ?? {})) {
  for (const id of Array.isArray(entity?.sessionIds) ? entity.sessionIds : []) {
    workspaceRows.push({ workspaceKey: key, id: String(id) })
  }
}

const cacheKeys = Object.keys(projcache?.tables?.sessions ?? {})

say('=== 本机磁盘状态 ===')
say(`  DSH 根：${HOME}`)
say(`  回收箱记录：${entries.length} 条`)
for (const entry of entries) {
  const left = typeof entry.at === 'number'
    ? Math.max(0, Math.ceil((entry.at + (entry.keptDays ?? 7) * DAY - Date.now()) / DAY))
    : '?'
  say(`    - ${entry.id}  phase=${entry.phase}  title=${entry.title ?? '(无)'}  剩余≈${left} 天`)
}

// 第 2 条：workspace 里还有没有已删除的 id
const ghosts = workspaceRows.filter((row) => trashIds.has(row.id))
say('')
say('=== 证据 2：workspace 成员里是否还有已删除的 id ===')
say(ghosts.length === 0
  ? '  ✔ 没有残留（侧栏不会再显示它们）'
  : '  ✖ 仍有残留：' + ghosts.map((row) => `${row.workspaceKey}/${row.id}`).join('、'))

// 第 3 条：projection cache
const cacheGhosts = cacheKeys.filter((key) => trashIds.has(key) || trashIds.has('session-' + key))
say('')
say('=== 证据 3：projection cache 里是否还有已删除的 id ===')
say(cacheGhosts.length === 0
  ? '  ✔ 没有残留'
  : '  ✖ 仍有残留：' + cacheGhosts.join('、'))

// 第 4 条：接口
async function httpTrash() {
  try {
    const tokenResponse = await fetch(`${BASE}/api/archive-manager/token`, { headers: { host: BASE.replace(/^https?:\/\//, '') } })
    const tokenBody = await tokenResponse.json()
    const response = await fetch(`${BASE}/api/archive-manager/trash`, {
      headers: {
        host: BASE.replace(/^https?:\/\//, ''),
        origin: BASE,
        'x-dsh-toolbox': '1',
        'x-dsh-toolbox-token': tokenBody.token,
      },
    })
    return { status: response.status, body: await response.json() }
  } catch (error) {
    return { status: 0, body: undefined, error: String(error?.message ?? error) }
  }
}

const trash = await httpTrash()
say('')
say('=== 证据 4：回收箱接口 ===')
if (trash.status === 200) {
  say(`  ✔ HTTP 200  protectedCount=${trash.body.protectedCount}  maxProtected=${trash.body.maxProtected}  keptDays=${trash.body.keptDays}`)
  for (const row of trash.body.rows ?? []) {
    const left = typeof row.expiresAt === 'number'
      ? Math.max(0, Math.ceil((row.expiresAt - Date.now()) / DAY))
      : '?'
    say(`    - ${row.title ?? '(无标题)'}  ${row.phase}  剩余 ${left} 天`)
  }
} else {
  say(`  ✖ HTTP ${trash.status}${trash.error ? '  ' + trash.error : ''}`)
}

// 第 6 条：归档集合
const archived = Array.isArray(workspace.global?.archivedSessionIds) ? workspace.global.archivedSessionIds : []
const archiveGhosts = archived.filter((id) => trashIds.has(String(id)))
say('')
say('=== 证据 6：归档集合里是否还有回收箱里的 id ===')
say(archived.length === 0
  ? '  ✔ 归档集合是空的'
  : archiveGhosts.length === 0
    ? `  ✔ 没有交集（归档集合 ${archived.length} 条，回收箱 ${entries.length} 条）`
    : '  ✖ 仍有交集：' + archiveGhosts.join('、'))

say('')
say('说明：证据 1（删除后侧栏立即消失）与证据 5（恢复回原工作区）需要真点一次，')
say('      本脚本只做磁盘与接口侧的核对。')
