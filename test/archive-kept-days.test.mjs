/**
 * 回收箱保留天数必须可配置：7 只是默认值。
 *
 * 开源产品不能把「留几天」写死——用户可能想 3 天快清，也可能要 30 天兜底。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readTrashKeptDays, CONFIG_DEFAULTS } from '../src/host/config.js'
import { createArchiveService } from '../src/host/features/archive/service.js'
import { makeWorld, ID_A } from './support/archive-service-matrix.mjs'
import { TRASH_KEPT_DAYS_OPTIONS, TRASH_KEPT_DAYS_DEFAULT } from '../src/shared/switches.js'

test('天数 · 默认是 7，且写进 CONFIG_DEFAULTS', () => {
  assert.equal(TRASH_KEPT_DAYS_DEFAULT, 7)
  assert.equal(CONFIG_DEFAULTS.trashKeptDays, 7)
  assert.deepEqual([...TRASH_KEPT_DAYS_OPTIONS], [3, 7, 14, 30, 60])
})

test('天数 · 用户可选值都能读到', () => {
  for (const days of TRASH_KEPT_DAYS_OPTIONS) {
    assert.equal(readTrashKeptDays({ trashKeptDays: days }), days)
  }
})

test('天数 · 非法或越界的值会被夹回合法范围', () => {
  assert.equal(readTrashKeptDays({}), 7, '缺失回落默认')
  assert.equal(readTrashKeptDays({ trashKeptDays: 'abc' }), 7)
  assert.equal(readTrashKeptDays({ trashKeptDays: 0 }), 1, '下限 1')
  assert.equal(readTrashKeptDays({ trashKeptDays: 999 }), 90, '上限 90')
  assert.equal(readTrashKeptDays({ trashKeptDays: 7.6 }), 8, '四舍五入')
})

test('天数 · 服务层每次调用都现读配置（改了立刻生效）', async () => {
  let days = 7
  const { deps } = makeWorld({ trashKeptDays: () => days })
  const service = createArchiveService(deps)
  await service.delete(ID_A)

  assert.equal(service.listTrash().keptDays, 7)
  days = 30
  assert.equal(service.listTrash().keptDays, 30, '配置改了，不用重建服务')
  days = 3
  assert.equal(service.listTrash().keptDays, 3)
})
