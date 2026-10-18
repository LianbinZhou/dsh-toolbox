/**
 * 插件说明汉化（S5 从独立插件迁入）：**可逆**是这次新增的关键能力。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLUGIN_ZH_DICT,
  buildLookup,
  normalize,
  translateTextNode,
  restoreApplied,
  mountPluginZh,
} from '../src/client/features/plugin-zh.js'

const lookup = buildLookup(PLUGIN_ZH_DICT)
const EN = 'The shared dsh core as a profile bundle: the first patch layer of base-backed profiles, inserting core rows over the empty profile root'

test('字典 · 28 条全部可命中', () => {
  assert.equal(Object.keys(PLUGIN_ZH_DICT).length, 28)
  for (const en of Object.keys(PLUGIN_ZH_DICT)) {
    assert.ok(lookup(en), '命中失败: ' + en.slice(0, 40))
  }
})

test('匹配 · 精确命中', () => {
  assert.equal(lookup(EN), PLUGIN_ZH_DICT[EN])
})

test('匹配 · 前 40 字符命中（容忍尾部截断）', () => {
  assert.equal(lookup(EN.slice(0, 45)), PLUGIN_ZH_DICT[EN])
})

test('匹配 · 普通短文本不误伤', () => {
  assert.equal(lookup('设置'), undefined)
  assert.equal(lookup('Plugins'), undefined)
  assert.equal(lookup(''), undefined)
})

test('可逆 · 翻译后 dispose 能还原英文原文', () => {
  const applied = []
  const node = { parentElement: { tagName: 'DIV' }, nodeValue: EN }
  assert.equal(translateTextNode(node, lookup, applied), true)
  assert.notEqual(node.nodeValue, EN)
  assert.equal(applied.length, 1)
  assert.equal(applied[0].original, EN, '必须记下原文')

  const restored = restoreApplied(applied)
  assert.equal(restored, 1)
  assert.equal(node.nodeValue, EN, '英文必须回来')
  assert.equal(node.__dshToolboxZh, undefined, '标记要清掉，下次还能再翻')
})

test('可逆 · 同一个节点重复翻译不会重复记录', () => {
  const applied = []
  const node = { parentElement: { tagName: 'DIV' }, nodeValue: EN }
  translateTextNode(node, lookup, applied)
  translateTextNode(node, lookup, applied)
  assert.equal(applied.length, 1, '第二次应被幂等跳过')
})

test('跳过 · code/pre 内的文本不动', () => {
  const applied = []
  const node = { parentElement: { tagName: 'CODE' }, nodeValue: EN }
  assert.equal(translateTextNode(node, lookup, applied), false)
  assert.equal(node.nodeValue, EN)
})

test('mount · 非中文界面不工作（且 dispose 安全）', () => {
  const handle = mountPluginZh({ locale: 'en' })
  assert.doesNotThrow(() => handle.dispose())
})
