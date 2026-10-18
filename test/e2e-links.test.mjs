/**
 * 4 条闭环链路的 E2E 测试（真实 fs + 真实 journal + 真实 service/adapter）。
 *
 * 链路：
 *   1. 工作区 → 归档 → 删除 → 回收站
 *   2. 工作区 → 归档 → 恢复 → 工作区
 *   3. 工作区 → 归档 → 删除 → 回收站 → 恢复 → 工作区
 *   4. 工作区 → 归档 → 删除 → 回收站 → 彻底删除
 *
 * 假 registry 刻意复刻真实实现的关键行为：
 *   `sessionIds` 是 **filtered getter** —— 目录一旦不在原位置，
 *   它就不再返回那一行。这正是「删除后 workspace 行摘不掉」的机制。
 *   所以这些测试能证明：靠 getter 找行一定会失败，靠快照/原始记录才能成功。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createArchiveService } from '../src/host/features/archive/service.js'
import { createArchiveApi } from '../src/host/features/archive/service-deps.js'
import { createSessionAdapter } from '../src/host/features/archive/session-adapter.js'
import { createFileJournal } from '../src/host/features/archive/journal.js'

const PROJECT = 'projA'

function makeWorld() {
  const base = mkdtempSync(join(tmpdir(), 'tbx-e2e-'))
  const home = join(base, 'storages')
  const sessionsRoot = join(base, 'sessions')
  const workspaceId = 'ws-1'
  const sessionId = 'session-aaaaaaaa-1111-2222-3333-444444444444'
  const sessionDir = join(sessionsRoot, PROJECT, sessionId)

  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'transcript.jsonl'), '{"type":"header"}\n', 'utf8')
  mkdirSync(join(home, 'archive'), { recursive: true })

  // 原始记录 + filtered getter：目录不在原位置时，sessionIds 会把它藏起来
  const record = { id: workspaceId, path: join(base, 'project-path'), sessionIds: [sessionId, 'session-other-2222'] }
  const entity = {
    id: workspaceId,
    get record() {
      return record
    },
    get sessionIds() {
      return record.sessionIds.filter((id) => existsSync(join(sessionsRoot, PROJECT, String(id))))
    },
    async mutate(fn) {
      const next = fn(record)
      record.sessionIds = Array.isArray(next.sessionIds) ? next.sessionIds : record.sessionIds
    },
  }

  const archived = new Set()
  const registry = {
    get archivedSessionIds() {
      return [...archived]
    },
    list() {
      return [entity]
    },
    async archiveSession(id) {
      archived.add(String(id))
    },
    async unarchiveSession(id) {
      archived.delete(String(id))
    },
  }

  const journal = createFileJournal(join(home, 'archive'))
  // isLive 是失败关闭的：没有 sessions 服务时它会拒绝一切删除。
  // 这里给一个「没有任何会话在跑」的假服务。
  const sessions = { get: () => undefined }
  const adapter = createSessionAdapter({ registry, sessions, sessionsRoot })
  const built = createArchiveApi({
    home,
    adapter,
    ttlDays: () => 14,
  })
  const service = built.service

  const state = () => {
    const entries = journal.read().map((entry) => ({ id: entry.id, phase: entry.phase, seat: entry.workspaceSeat }))
    const entry = entries.find((item) => item.id === sessionId)
    const trashPath = journal.read().find((item) => item.id === sessionId)?.trashPath
    return {
      archived: [...archived],
      workspaceRows: [...record.sessionIds],
      entries,
      phase: entry?.phase,
      seat: entry?.seat,
      dirInPlace: existsSync(sessionDir),
      dirInTrash: trashPath ? existsSync(trashPath) : false,
    }
  }

  const cleanup = () => rmSync(base, { recursive: true, force: true })
  return { base, home, sessionsRoot, workspaceId, sessionId, sessionDir, registry, entity, journal, service, state, cleanup }
}

test('链路 1 · 工作区 → 归档 → 删除 → 回收站', async () => {
  const w = makeWorld()
  try {
    assert.equal(w.state().dirInPlace, true)
    assert.equal(w.state().workspaceRows.includes(w.sessionId), true, '初始应在工作区')

    await w.registry.archiveSession(w.sessionId)
    assert.equal(w.state().archived.includes(w.sessionId), true, '归档后集合里应有它')

    const removed = await w.service.delete(w.sessionId, { title: 'E2E 会话' })
    assert.equal(removed.ok, true)
    assert.equal(removed.recovered === true || removed.recoverable === true, true)

    const s = w.state()
    assert.equal(s.dirInPlace, false, '原位置应已清空')
    assert.equal(s.dirInTrash, true, '目录应在回收箱')
    assert.equal(s.phase, 'cleaned', '收尾后应是 cleaned')
    assert.equal(s.archived.includes(w.sessionId), false, '归档标记必须清掉')
    assert.equal(s.workspaceRows.includes(w.sessionId), false, '工作区行必须摘掉（否则侧栏残留）')
  } finally {
    w.cleanup()
  }
})

test('链路 2 · 工作区 → 归档 → 恢复 → 工作区', async () => {
  const w = makeWorld()
  try {
    await w.registry.archiveSession(w.sessionId)

    const back = await w.service.unarchiveSession(w.sessionId)
    assert.equal(back.ok, true)

    const s = w.state()
    assert.equal(s.archived.includes(w.sessionId), false, '归档标记应清掉')
    assert.equal(s.dirInPlace, true, '目录应仍在原位')
    assert.equal(s.workspaceRows.includes(w.sessionId), true, '应还在工作区')
  } finally {
    w.cleanup()
  }
})

test('链路 3 · 工作区 → 归档 → 删除 → 回收站 → 恢复 → 工作区（重点：回到原位置）', async () => {
  const w = makeWorld()
  try {
    await w.registry.archiveSession(w.sessionId)
    const removed = await w.service.delete(w.sessionId, { title: 'E2E 会话' })
    assert.equal(removed.ok, true)
    assert.equal(w.state().workspaceRows.includes(w.sessionId), false)

    // 删除时记下了工作区位置
    assert.ok(w.state().seat, '删除时必须快照工作区成员身份')
    assert.equal(w.state().seat.workspaceId, w.workspaceId)

    const back = await w.service.unarchiveSession(w.sessionId)
    assert.equal(back.ok, true)

    const s = w.state()
    assert.equal(s.dirInPlace, true, '目录应回到原位')
    assert.equal(s.workspaceRows.includes(w.sessionId), true, '应回到原工作区')
    // 位置：必须排在它原来的后一个成员之前（session-other-2222 之前）
    const index = s.workspaceRows.indexOf(w.sessionId)
    assert.equal(index, 0, '应回到原来的位置（在 session-other-2222 之前）')
  } finally {
    w.cleanup()
  }
})

test('链路 4 · 工作区 → 归档 → 删除 → 回收站 → 彻底删除', async () => {
  const w = makeWorld()
  try {
    await w.registry.archiveSession(w.sessionId)
    await w.service.delete(w.sessionId, { title: 'E2E 会话' })

    const purged = await w.service.purge(w.sessionId)
    assert.equal(purged.ok, true)
    assert.equal(purged.purged, true)

    const s = w.state()
    assert.equal(s.entries.length, 0, 'journal 里不能再有它')
    assert.equal(s.dirInPlace, false)
    assert.equal(s.dirInTrash, false, '垃圾箱里的目录也要物理删掉')
    assert.equal(s.archived.includes(w.sessionId), false)
    assert.equal(s.workspaceRows.includes(w.sessionId), false, '工作区行不能留幽灵')
  } finally {
    w.cleanup()
  }
})

test('链路 5 · 四条链路连跑：状态机不串味', async () => {
  const w = makeWorld()
  try {
    // 1：归档 → 删除
    await w.registry.archiveSession(w.sessionId)
    await w.service.delete(w.sessionId)
    assert.equal(w.state().phase, 'cleaned')

    // 2：恢复
    await w.service.unarchiveSession(w.sessionId)
    assert.equal(w.state().dirInPlace, true)
    assert.equal(w.state().entries.length, 0)

    // 3：再归档 → 再删除 → 再恢复（幂等）
    await w.registry.archiveSession(w.sessionId)
    await w.service.delete(w.sessionId)
    assert.equal(w.state().phase, 'cleaned')
    await w.service.unarchiveSession(w.sessionId)
    assert.equal(w.state().workspaceRows.includes(w.sessionId), true)

    // 4：再删除 → 彻底删除
    await w.registry.archiveSession(w.sessionId)
    await w.service.delete(w.sessionId)
    const purged = await w.service.purge(w.sessionId)
    assert.equal(purged.ok, true)
    assert.equal(w.state().entries.length, 0)
    assert.equal(w.state().workspaceRows.includes(w.sessionId), false)
  } finally {
    w.cleanup()
  }
})


test('链路 6a · 幽灵态：归档后目录被删，恢复必须报 dir-absent 且不造分身', async () => {
  const w = makeWorld()
  try {
    await w.registry.archiveSession(w.sessionId)
    rmSync(w.sessionDir, { recursive: true, force: true })
    const rowsBefore = w.state().workspaceRows.length

    const restored = await w.service.unarchiveSession(w.sessionId)
    assert.equal(restored.ok, false, '目录不存在时恢复必须失败')
    assert.equal(restored.reason, 'dir-absent', '要给前端一个能读懂的原因')
    assert.equal(w.state().workspaceRows.length, rowsBefore, '绝不能往工作区里再加一行（「未分组」就是这么冒出来的）')
    assert.equal(w.state().archived.includes(w.sessionId), false, '底层残留标记要顺手清掉，否则归档页也有它')
  } finally {
    w.cleanup()
  }
})

test('链路 6b · 幽灵态：归档后目录被删，删除应退化成清理且不留标记', async () => {
  const w = makeWorld()
  try {
    await w.registry.archiveSession(w.sessionId)
    rmSync(w.sessionDir, { recursive: true, force: true })
    const rowsBefore = w.state().workspaceRows.length

    const removed = await w.service.delete(w.sessionId)
    assert.equal(removed.ok, true, '目录不在了，删除应退化成清理并成功')
    const s = w.state()
    assert.equal(s.workspaceRows.includes(w.sessionId), false, '删除必须把它从工作区摘掉（否则侧栏还看得到）')
    assert.equal(s.archived.includes(w.sessionId), false, '归档标记必须清掉')
    assert.equal(s.entries.filter((entry) => entry.id === w.sessionId).length, 0, '没有可恢复的东西，就不该留记录')
  } finally {
    w.cleanup()
  }
})

test('链路 7 · 幽灵态下的彻底删除：不留任何标记', async () => {
  const w = makeWorld()
  try {
    await w.registry.archiveSession(w.sessionId)
    rmSync(w.sessionDir, { recursive: true, force: true })

    await w.service.delete(w.sessionId)
    const purged = await w.service.purge(w.sessionId)
    assert.equal(purged.ok === true || purged.ok === false, true)

    const s = w.state()
    assert.equal(s.workspaceRows.includes(w.sessionId), false)
    assert.equal(s.archived.includes(w.sessionId), false)
  } finally {
    w.cleanup()
  }
})


test('链路 9 · 未分组会话：归档 → 删除，收尾必须成功（不能停在 trashed）', async () => {
  const w = makeWorld()
  try {
    // 「未分组」= 磁盘上有目录，但不属于任何工作区实体。
    w.entity.record.sessionIds = w.entity.record.sessionIds.filter((id) => id !== w.sessionId)
    assert.equal(w.state().workspaceRows.includes(w.sessionId), false, '前提：这条确实不在任何工作区里')

    await w.registry.archiveSession(w.sessionId)
    const removed = await w.service.delete(w.sessionId, { title: '未分组会话' })

    assert.equal(removed.ok, true, '删除本身要成功')
    const s = w.state()
    assert.equal(s.phase, 'cleaned', '未分组会话没有行可摘，cleanup 不能因此判失败')
    assert.equal(s.dirInPlace, false, '目录必须离开原位（侧栏是从磁盘发现未分组会话的）')
    assert.equal(s.dirInTrash, true)
    assert.equal(s.archived.includes(w.sessionId), false, '归档标记要清掉')
    assert.equal(s.entries.filter((entry) => entry.id === w.sessionId).length, 1)
  } finally {
    w.cleanup()
  }
})

test('链路 10 · 未分组会话：删除后恢复，回到未分组（而不是报错或造行）', async () => {
  const w = makeWorld()
  try {
    w.entity.record.sessionIds = w.entity.record.sessionIds.filter((id) => id !== w.sessionId)
    await w.registry.archiveSession(w.sessionId)
    await w.service.delete(w.sessionId)

    const back = await w.service.unarchiveSession(w.sessionId)
    assert.equal(back.ok, true, '恢复文件本身应成功')
    // 未分组会话没有 seat：文件回到磁盘，侧栏会把它重新算进未分组，不能硬塞进某个工作区。
    assert.equal(w.state().dirInPlace, true, '目录必须回到原位')
    assert.equal(w.state().workspaceRows.includes(w.sessionId), false, '不能凭空塞进工作区')
  } finally {
    w.cleanup()
  }
})
