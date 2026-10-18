/**
 * 官方兼容防腐层：接口缺失时只降级，绝不崩。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createDshAdapter, callOptional, SERVICE_CHECKS } from '../src/client/dsh-adapter.js'

function silentLogger() {
  const lines = []
  return { lines, warn: (message) => lines.push(message), info: () => {}, error: () => {} }
}

test('adapter · 服务齐全时全部可用', () => {
  const ctx = {
    slots: { register() {}, inject() {} },
    sessions: { async refresh() {} },
    configForms: { get() {} },
    layout: { selectPanel() {} },
    locale: { register() {} },
  }
  const dsh = createDshAdapter(ctx)
  assert.ok(dsh.get('slots'))
  assert.ok(dsh.get('sessions'))
  assert.equal(dsh.selfCheck().ok, true)
})

test('adapter · 缺服务时返回 undefined 并只警告一次', () => {
  const logger = silentLogger()
  const dsh = createDshAdapter({ slots: { register() {}, inject() {} } }, { logger })
  assert.equal(dsh.get('sessions'), undefined)
  assert.equal(dsh.get('sessions'), undefined, '第二次读也不抛')
  assert.equal(logger.lines.length, 1, '同一个服务只警告一次，别刷屏')
  assert.ok(dsh.selfCheck().missing.includes('sessions'), '缺失清单必须包含 sessions')
  assert.equal(dsh.selfCheck().ok, false)
})

test('adapter · 形状不对（官方改接口）算降级，不算可用', () => {
  const logger = silentLogger()
  const ctx = { slots: { register() {}, inject() {} }, sessions: { get() {} } }
  const dsh = createDshAdapter(ctx, { logger })
  assert.equal(dsh.get('sessions'), undefined, '没有 refresh 也没有 list → 形状不匹配')
  assert.deepEqual(dsh.selfCheck().degraded, ['sessions'])
})

test('adapter · ctx 属性读取抛异常时不崩', () => {
  const ctx = {
    get slots() { throw new Error('undeclared service') },
    get(name) { return name === 'slots' ? { register() {}, inject() {} } : undefined },
  }
  const dsh = createDshAdapter(ctx, { logger: silentLogger() })
  assert.ok(dsh.get('slots'), '属性读抛了要回退到 ctx.get()')
})

test('adapter · 必需服务缺失时 require 明确抛错', () => {
  const dsh = createDshAdapter({}, { logger: silentLogger() })
  assert.throws(() => dsh.require('slots'), /缺少必需的官方服务/)
  assert.throws(() => dsh.require('sessions'), /缺少必需的官方服务/, 'sessions 也是必需服务（web profile 必有）')
  assert.equal(dsh.require('configForms'), undefined, '可选服务缺失只返回 undefined')
})

test('callOptional · 方法不存在或抛错都返回 undefined', async () => {
  assert.equal(await callOptional({}, 'refresh'), undefined)
  assert.equal(await callOptional(null, 'refresh'), undefined)
  assert.equal(await callOptional({ refresh() { throw new Error('boom') } }, 'refresh'), undefined)
  assert.equal(await callOptional({ refresh: () => 42 }, 'refresh'), 42)
})

test('SERVICE_CHECKS · 覆盖工具箱依赖的全部官方服务', () => {
  assert.deepEqual(Object.keys(SERVICE_CHECKS).sort(), ['configForms', 'layout', 'locale', 'sessions', 'slots'])
})
