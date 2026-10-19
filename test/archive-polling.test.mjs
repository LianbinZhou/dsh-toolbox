/**
 * 归档面板轮询器的三条规矩（Pi 钦定）：
 *   1. 页面隐藏时暂停；
 *   2. stop() 彻底清理；
 *   3. id 列表一样就不通知重渲染。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { startArchivePolling } from '../src/client/features/archive-panel.js'

function fakePanel(initialIds) {
  let ids = [...initialIds]
  let refreshes = 0
  let pending = null
  return {
    setIds(next) {
      ids = [...next]
    },
    /** 下一次 refresh 会把数据换成这个（模拟真的拉到了新列表）。 */
    onNextRefresh(next) {
      pending = [...next]
    },
    refreshes: () => refreshes,
    refresh: async () => {
      refreshes += 1
      if (pending !== null) {
        ids = pending
        pending = null
      }
    },
    view: () => ({ rows: ids.map((id) => ({ id })) }),
  }
}

test('轮询 · id 列表没变时不通知重渲染（防闪）', async () => {
  const panel = fakePanel(['a', 'b'])
  let notified = 0
  const poller = startArchivePolling({ panel, onChange: () => { notified += 1 }, intervalMs: 999999 })
  try {
    await poller.tick()
    await poller.tick()
    assert.equal(panel.refreshes(), 2, '数据还是拉了两次')
    assert.equal(notified, 0, '但 id 没变，绝不能通知重渲染')
  } finally {
    poller.stop()
  }
})

test('轮询 · id 列表变了才通知一次', async () => {
  const panel = fakePanel(['a'])
  let notified = 0
  const poller = startArchivePolling({ panel, onChange: () => { notified += 1 }, intervalMs: 999999 })
  try {
    await poller.tick()
    panel.onNextRefresh(['a', 'b'])
    await poller.tick()
    assert.equal(notified, 1, '变了就该通知一次')
    await poller.tick()
    assert.equal(notified, 1, '没再变就不重复通知')
  } finally {
    poller.stop()
  }
})

test('轮询 · 页面隐藏时一次都不拉数据', async () => {
  const panel = fakePanel(['a'])
  const doc = { visibilityState: 'hidden', addEventListener: () => {}, removeEventListener: () => {} }
  const poller = startArchivePolling({ panel, onChange: () => {}, doc, intervalMs: 999999 })
  try {
    await poller.tick()
    await poller.tick()
    assert.equal(panel.refreshes(), 0, '后台标签页不许空转')
  } finally {
    poller.stop()
  }
})

test('轮询 · 页面重新可见后恢复', async () => {
  const panel = fakePanel(['a'])
  const handlers = {}
  const doc = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => {
      handlers[name] = fn
    },
    removeEventListener: () => {},
  }
  const poller = startArchivePolling({ panel, onChange: () => {}, doc, intervalMs: 999999 })
  try {
    await poller.tick()
    assert.equal(panel.refreshes(), 1)

    doc.visibilityState = 'hidden'
    handlers.visibilitychange()
    assert.equal(poller.isRunning(), false, '隐藏时定时器要停')

    doc.visibilityState = 'visible'
    handlers.visibilitychange()
    assert.equal(poller.isRunning(), true, '回来后要恢复')
  } finally {
    poller.stop()
  }
})

test('轮询 · stop 之后不再拉数据、定时器也没了', async () => {
  const panel = fakePanel(['a'])
  const poller = startArchivePolling({ panel, onChange: () => {}, intervalMs: 999999 })
  assert.equal(poller.isRunning(), true)
  poller.stop()
  assert.equal(poller.isRunning(), false, '定时器必须清掉')
  await poller.tick()
  assert.equal(panel.refreshes(), 0, '停了以后一次都不许再拉')
})

test('轮询 · refresh 抛错不会把轮询搞死', async () => {
  let calls = 0
  const panel = {
    refresh: async () => {
      calls += 1
      throw new Error('boom')
    },
    view: () => ({ rows: [] }),
  }
  const poller = startArchivePolling({ panel, onChange: () => {}, intervalMs: 999999 })
  try {
    await poller.tick()
    await poller.tick()
    assert.equal(calls, 2, '抛错后下一轮照常跑')
  } finally {
    poller.stop()
  }
})
