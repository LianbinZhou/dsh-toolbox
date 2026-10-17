/**
 * S4-c · the panel's state machine.
 *
 * The old panel showed a spinner and then "删除失败" for everything. These tests
 * pin the three states that matter: the switch is off (NO request), the credential
 * is gone (reload), and the service's own refusal (a readable sentence).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createArchivePanel, REASON_TEXT } from '../src/client/features/archive-panel-model.js'

function fakeClient(script = {}) {
  const calls = { list: 0, delete: 0, unarchive: 0, dispose: 0 }
  return {
    calls,
    async list() {
      calls.list += 1
      return script.list ?? { ok: true, rows: [{ id: 'session-aaaaaaaa-1111-2222-3333-444444444444', phase: 'archived' }] }
    },
    async delete() {
      calls.delete += 1
      return script.delete ?? { ok: true, status: 200 }
    },
    async unarchive() {
      calls.unarchive += 1
      return script.unarchive ?? { ok: true, status: 200 }
    },
    dispose() {
      calls.dispose += 1
    },
  }
}

test('panel · switch OFF makes no request at all', async () => {
  const client = fakeClient()
  const panel = createArchivePanel({ client, isEnabled: () => false })
  const result = await panel.refresh()
  assert.equal(result.ok, false)
  assert.equal(client.calls.list, 0, 'a disabled panel must not even ask for a token')
  const view = panel.view()
  assert.equal(view.state, 'disabled')
  assert.match(view.message, /未启用/)
  assert.equal(view.canDelete, false)
})

test('panel · switch ON lists the rows', async () => {
  const client = fakeClient()
  const panel = createArchivePanel({ client, isEnabled: () => true })
  assert.equal((await panel.refresh()).ok, true)
  const view = panel.view()
  assert.equal(view.state, 'ready')
  assert.equal(view.rows.length, 1)
  assert.equal(view.canDelete, true)
})

test('panel · a lost credential says "reload", not "delete failed"', async () => {
  const client = fakeClient({ list: { ok: false, reason: 'refresh-required' } })
  const panel = createArchivePanel({ client, isEnabled: () => true })
  await panel.refresh()
  assert.equal(panel.view().state, 'error')
  assert.match(panel.view().message, /刷新页面/)
})

test('panel · an unmounted route points at the switch', async () => {
  const client = fakeClient({ list: { ok: false, reason: 'http-404' } })
  const panel = createArchivePanel({ client, isEnabled: () => true })
  await panel.refresh()
  assert.match(panel.view().message, /第 7 个开关/)
})

test('panel · the service reasons are phrased per case', async () => {
  const cases = [
    ['live', /正在使用中/],
    ['trash-full', /回收站已满/],
    ['journal-corrupt', /损坏/],
    ['not-archived', /已经不在归档列表/],
    ['archive-session-adapter-unavailable', /还没接上会话服务/],
  ]
  for (const [reason, pattern] of cases) {
    const client = fakeClient({ delete: { ok: false, status: 409, reason } })
    const panel = createArchivePanel({ client, isEnabled: () => true })
    await panel.refresh()
    await panel.remove('session-aaaaaaaa-1111-2222-3333-444444444444')
    assert.match(panel.view().message, pattern, reason)
  }
})

test('panel · every reason in the table is a real sentence', () => {
  for (const [key, text] of Object.entries(REASON_TEXT)) {
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 4, key + ' must be readable')
    assert.notEqual(text, '删除失败', key + ' must not be the generic failure')
  }
})

test('panel · a successful delete refreshes the list', async () => {
  const client = fakeClient()
  const panel = createArchivePanel({ client, isEnabled: () => true })
  await panel.refresh()
  await panel.remove('session-aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(client.calls.delete, 1)
  assert.equal(client.calls.list, 2, 'after a delete the rows are re-read')
})

test('panel · dispose clears state and the client', () => {
  const client = fakeClient()
  const panel = createArchivePanel({ client, isEnabled: () => true })
  panel.dispose()
  assert.equal(client.calls.dispose, 1)
  assert.equal(panel.view().state, 'idle')
  assert.equal(panel.view().rows.length, 0)
})
