/**
 * 回收箱页签（面板内二级视图，不新增侧栏入口）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createArchivePanel } from '../src/client/features/archive-panel-model.js'

function fakeClient(script = {}) {
  const calls = { list: 0, trash: 0, restore: 0, purge: 0 }
  return {
    calls,
    async list() { calls.list += 1; return { ok: true, rows: [] } },
    async titleMap() { return {} },
    async trash() {
      calls.trash += 1
      return script.trash ?? { ok: true, rows: [{ id: 'session-aaaaaaaa-1111-2222-3333-444444444444', title: '清理旧安装并重装Easel', phase: 'cleaned', keptDays: 7, at: 1 }], protectedCount: 3, maxProtected: 200, keptDays: 7 }
    },
    async restoreFromTrash() { calls.restore += 1; return script.restore ?? { ok: true } },
    async purge() { calls.purge += 1; return script.purge ?? { ok: true } },
    dispose() {},
  }
}

test('页签 · 默认是归档，切换后是回收箱', async () => {
  const client = fakeClient()
  const panel = createArchivePanel({ client, isEnabled: () => true })
  assert.equal(panel.view().view, 'archive')
  await panel.refreshTrash()
  assert.equal(panel.view().view, 'trash')
  assert.equal(panel.view().trash.rows.length, 1)
  assert.equal(panel.view().trash.maxProtected, 200)
  panel.switchTo('archive')
  assert.equal(panel.view().view, 'archive')
})

test('页签 · 开关关闭时不发任何回收箱请求', async () => {
  const client = fakeClient()
  const panel = createArchivePanel({ client, isEnabled: () => false })
  await panel.refreshTrash()
  assert.equal(client.calls.trash, 0, '关闭时零请求')
  assert.equal(panel.view().state, 'disabled')
})

test('页签 · 彻底删除必须二次确认', async () => {
  const client = fakeClient()
  const panel = createArchivePanel({ client, isEnabled: () => true })
  await panel.refreshTrash()
  panel.askPurge('session-aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(panel.view().purgePending, 'session-aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(client.calls.purge, 0, '问的时候不能执行')

  panel.cancelPurge()
  assert.equal(panel.view().purgePending, null)
  assert.equal(client.calls.purge, 0)

  panel.askPurge('session-aaaaaaaa-1111-2222-3333-444444444444')
  await panel.confirmPurge()
  assert.equal(client.calls.purge, 1)
})

test('页签 · 恢复后会刷新回收箱列表', async () => {
  const client = fakeClient()
  const panel = createArchivePanel({ client, isEnabled: () => true })
  await panel.refreshTrash()
  const before = client.calls.trash
  await panel.restoreTrash('session-aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(client.calls.restore, 1)
  assert.equal(client.calls.trash, before + 1, '恢复后列表要重新拉')
})

test('页签 · 回收箱行显示 journal 里的会话名，不是 id 尾段', async () => {
  const client = fakeClient()
  const panel = createArchivePanel({ client, isEnabled: () => true })
  await panel.refreshTrash()
  const row = panel.view().trash.rows[0]
  assert.equal(row.label, '清理旧安装并重装Easel', '必须用 journal 里的标题')
  assert.equal(/^会话 [0-9a-f]{8}$/.test(row.label), false, '不能退化成 id 尾段')
})


test('剩余天数 · 剩余 0.1 天显示 0（今天到期，不显示 1）', async () => {
  const DAY = 86400000
  const client = fakeClient()
  // 删除于「13.9 天前」：expiresAt = now + 0.1 天
  client.trash = async () => ({
    ok: true,
    rows: [{ id: 'session-aaaaaaaa-1111-2222-3333-444444444444', title: 'x', phase: 'cleaned', keptDays: 14, at: Date.now() - 13.9 * DAY, expiresAt: Date.now() + 0.1 * DAY }],
    protectedCount: 1,
    maxProtected: 200,
    keptDays: 14,
  })
  const panel = createArchivePanel({ client, isEnabled: () => true })
  await panel.refreshTrash()
  const row = panel.view().trash.rows[0]
  assert.equal(row.remainingDays, 0, '不到 1 天算 0（今天到期）')
})

test('剩余天数 · 还剩 13 天多时显示 13', async () => {
  const DAY = 86400000
  const client = fakeClient()
  client.trash = async () => ({
    ok: true,
    rows: [{ id: 'session-aaaaaaaa-1111-2222-3333-444444444444', title: 'x', phase: 'cleaned', keptDays: 14, at: Date.now() - DAY, expiresAt: Date.now() + 13.5 * DAY }],
    protectedCount: 1,
    maxProtected: 200,
    keptDays: 14,
  })
  const panel = createArchivePanel({ client, isEnabled: () => true })
  await panel.refreshTrash()
  assert.equal(panel.view().trash.rows[0].remainingDays, 13, '13.5 天必须显示 13')
})
