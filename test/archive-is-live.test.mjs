/**
 * 「正在使用」判定：会话对象在内存里 ≠ 在跑。
 *
 * 真机现场：running=false，却因为 sessions.get(id) 存在被拒（打开过就删不掉）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionAdapter } from '../src/host/features/archive/session-adapter.js'

function adapterWith(get) {
  return createSessionAdapter({
    registry: { archivedSessionIds: [], list: () => [], archiveSession: () => {}, unarchiveSession: () => {} },
    sessions: { get },
    sessionsRoot: 'C:/tmp/sessions',
  })
}

const ID = 'session-aaaaaaaa-1111-2222-3333-444444444444'

test('isLive · 会话没加载 → 不算活', () => {
  assert.equal(adapterWith(() => undefined).isLive(ID), false)
})

test('isLive · 加载了但没在跑 → 不算活（这是真机那个 bug）', () => {
  assert.equal(adapterWith(() => ({ running: false })).isLive(ID), false)
  assert.equal(adapterWith(() => ({ status: 'idle' })).isLive(ID), false)
})

test('isLive · 真的在跑 → 拒绝', () => {
  assert.equal(adapterWith(() => ({ running: true })).isLive(ID), true)
  assert.equal(adapterWith(() => ({ status: 'running' })).isLive(ID), true)
  assert.equal(adapterWith(() => ({ status: 'busy' })).isLive(ID), true)
})

test('isLive · 没有运行标志的会话对象 → 不拦（否则永远删不掉）', () => {
  assert.equal(adapterWith(() => ({ id: ID })).isLive(ID), false)
})

test('isLive · 读不到 sessions 服务时仍然失败关闭', () => {
  const adapter = createSessionAdapter({
    registry: { archivedSessionIds: [], list: () => [], archiveSession: () => {}, unarchiveSession: () => {} },
    sessions: undefined,
    sessionsRoot: 'C:/tmp/sessions',
  })
  assert.equal(adapter.isLive(ID), true, '拿不到会话服务时保守拒绝')
})
