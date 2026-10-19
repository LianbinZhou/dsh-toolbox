/**
 * 宿主侧防腐层：接口缺失时只降级，绝不崩。
 *
 * 这些测试先于实现写（红灯），因为 S4 的全部底层大坑都在宿主侧：
 * `WebRoute.method` 被移除、`workspaceRegistry` 晚到、`sessions.get` 语义变化……
 * 任何一个都能让整个归档功能挂掉，而客户端根本看不到原因。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createHostAdapter,
  HOST_SERVICE_CHECKS,
  HOST_REQUIRED_SERVICES,
} from '../src/host/dsh-adapter.js'

function silentLogger() {
  const lines = []
  return { lines, info: () => {}, warn: (m) => lines.push(m), error: () => {} }
}

test('宿主 adapter · 服务齐全时全部可用', () => {
  const ctx = {
    webServer: { register: () => () => {} },
    workspaceRegistry: { list: () => [], archivedSessionIds: [] },
    sessions: { get: () => undefined },
    sessionQuery: { search: () => [] },
  }
  const host = createHostAdapter(ctx)
  assert.ok(host.get('webServer'))
  assert.ok(host.get('workspaceRegistry'))
  assert.equal(host.selfCheck().ok, true)
})

test('宿主 adapter · 空 ctx 的 selfCheck 必须报红（不许假绿）', () => {
  const host = createHostAdapter({}, { logger: silentLogger() })
  const check = host.selfCheck()
  assert.equal(check.ok, false)
  assert.deepEqual(check.missing.slice().sort(), ['sessionQuery', 'sessions', 'webServer', 'workspaceRegistry'])
})

test('宿主 adapter · 缺服务只警告一次，不抛', () => {
  const logger = silentLogger()
  const host = createHostAdapter({}, { logger })
  assert.equal(host.get('webServer'), undefined)
  assert.equal(host.get('webServer'), undefined, '第二次读也不抛')
  assert.equal(logger.lines.length, 1, '同一个服务只警告一次')
})

test('宿主 adapter · 形状不匹配算降级（官方改接口）', () => {
  const host = createHostAdapter({ webServer: {} }, { logger: silentLogger() })
  assert.equal(host.get('webServer'), undefined, '没有 register 就是形状不对')
  assert.ok(host.selfCheck().degraded.includes('webServer'))
})

test('宿主 adapter · ctx 属性读取抛异常时回退 ctx.get()', () => {
  const ctx = {
    get webServer() {
      throw new Error('undeclared')
    },
    get(name) {
      return name === 'webServer' ? { register: () => () => {} } : undefined
    },
  }
  const host = createHostAdapter(ctx, { logger: silentLogger() })
  assert.ok(host.get('webServer'))
})

test('宿主 adapter · 必需服务缺失时 require 明确抛错', () => {
  const host = createHostAdapter({}, { logger: silentLogger() })
  assert.throws(() => host.require('webServer'), /缺少必需的宿主服务/)
  assert.equal(host.require('sessions'), undefined, '可选服务缺失只返回 undefined')
})

test('宿主 adapter · 必需服务清单与检查表覆盖四个官方服务', () => {
  assert.deepEqual(Object.keys(HOST_SERVICE_CHECKS).sort(), ['sessionQuery', 'sessions', 'webServer', 'workspaceRegistry'])
  assert.deepEqual([...HOST_REQUIRED_SERVICES].sort(), ['webServer', 'workspaceRegistry'])
})
