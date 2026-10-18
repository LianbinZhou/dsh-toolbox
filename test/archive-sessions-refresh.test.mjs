/**
 * 删除/恢复后必须让 DSH 的 Session 列表重新拉一次。
 *
 * 「未分组」= sessions.list 减去各工作区成员。删目录只改磁盘，
 * 不刷新 Session 列表，侧栏那一行就永远在。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { refreshHostSessionsOf } from '../src/client/features/archive-panel.js'

test('sessions · 有 sessions 服务时调用 refresh', async () => {
  let calls = 0
  const ctx = { sessions: { async refresh() { calls += 1 } } }
  const ok = await refreshHostSessionsOf(ctx)
  assert.equal(ok, true)
  assert.equal(calls, 1, '必须真的调一次 sessions.refresh')
})

test('sessions · 没有 sessions 服务时不炸、返回 false', async () => {
  const ok = await refreshHostSessionsOf({})
  assert.equal(ok, false)
})

test('sessions · refresh 抛错时不炸（侧栏最多需要手动刷新）', async () => {
  const ctx = { sessions: { async refresh() { throw new Error('boom') } } }
  const ok = await refreshHostSessionsOf(ctx)
  assert.equal(ok, false, '刷新失败不能连累删除操作')
})

test('sessions · 也接受 ctx.get(服务名) 的取法', async () => {
  let calls = 0
  const ctx = { get: (name) => (name === 'sessions' ? { async refresh() { calls += 1 } } : undefined) }
  const ok = await refreshHostSessionsOf(ctx)
  assert.equal(ok, true)
  assert.equal(calls, 1)
})
