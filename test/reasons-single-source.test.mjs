/**
 * 4.1 reason 单一来源。
 *
 * 这几条测试的价值：如果服务层加了新码而共享表没跟上，立刻红。
 * 用的是服务层真实的 REASONS 值，不是手写的假码。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { REASONS } from '../src/host/features/archive/service.js'
import { INTERNAL_REASONS, toWireReason, reasonText, WIRE_REASONS } from '../src/shared/reasons.js'
import { reasonTextFor } from '../src/client/features/archive-panel-model.js'

test('4.1 · 服务层每个真实码都有出网映射与中文文案', () => {
  for (const value of Object.values(REASONS)) {
    assert.ok(INTERNAL_REASONS.includes(value), '共享表缺这个码：' + value)
    const wire = toWireReason(value)
    assert.ok(WIRE_REASONS.has(wire), value + ' 的出网码不合法：' + wire)
    const text = reasonText(value)
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 2, value + ' 没有可读文案')
  }
})

test('4.1 · 关键码按 Pi 的表映射（不是两套码）', () => {
  assert.equal(toWireReason('session-is-live'), 'live')
  assert.equal(toWireReason('session-became-live'), 'live')
  assert.equal(toWireReason('cross-volume-trash'), 'cross-device')
  assert.equal(toWireReason('move-failed'), 'remove-failed')
  assert.equal(toWireReason('delete-in-progress'), 'in-progress')
  assert.equal(toWireReason('no-longer-archived'), 'not-archived')
  assert.equal(toWireReason('identity-changed'), 'identity-changed')
})

test('4.1 · 未知码一律收敛成 request-failed', () => {
  assert.equal(toWireReason('C:/secret/path'), 'request-failed')
  assert.equal(toWireReason(undefined), 'request-failed')
})

test('4.1 · UI 对内部码和出网码都能给出中文', () => {
  assert.match(reasonTextFor('session-is-live'), /正在使用中/)
  assert.match(reasonTextFor('live'), /正在使用中/)
  assert.match(reasonTextFor('trash-full'), /满/)
  assert.match(reasonTextFor('journal-corrupt'), /损坏/)
  assert.notEqual(reasonTextFor('session-is-live'), reasonTextFor('request-failed'), '不能退化成通用兜底')
})
