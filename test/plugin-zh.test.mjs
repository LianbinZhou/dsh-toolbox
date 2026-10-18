/**
 * 插件说明汉化：匹配、可逆、以及**React 重渲染下的安全**。
 *
 * 重点在最后几组：节点被改写 / 替换 / 复用 / 脱离 DOM 时不能泄漏、不能覆盖新文本。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLUGIN_ZH_DICT,
  buildLookup,
  translateTextNode,
  restoreApplied,
  pruneApplied,
  mountPluginZh,
} from '../src/client/features/plugin-zh.js'

const lookup = buildLookup(PLUGIN_ZH_DICT)
const EN = 'The shared dsh core as a profile bundle: the first patch layer of base-backed profiles, inserting core rows over the empty profile root'
const ZH = PLUGIN_ZH_DICT[EN]

/** 最小文本节点替身：只需要 parentElement / nodeValue / isConnected。 */
function textNode(value, { connected = true } = {}) {
  return { parentElement: { tagName: 'DIV' }, nodeValue: value, isConnected: connected }
}

test('字典 · 28 条全部可命中', () => {
  assert.equal(Object.keys(PLUGIN_ZH_DICT).length, 28)
  for (const en of Object.keys(PLUGIN_ZH_DICT)) assert.ok(lookup(en), '命中失败: ' + en.slice(0, 40))
})

test('匹配 · 精确 / 前 40 字符 / 不误伤短文本', () => {
  assert.equal(lookup(EN), ZH)
  assert.equal(lookup(EN.slice(0, 45)), ZH)
  assert.equal(lookup('设置'), undefined)
  assert.equal(lookup('Plugins'), undefined)
})

test('可逆 · 翻译后 restore 还原英文', () => {
  const applied = new Map()
  const node = textNode(EN)
  assert.equal(translateTextNode(node, lookup, applied), true)
  assert.equal(node.nodeValue, ZH)
  assert.equal(applied.size, 1)
  assert.equal(applied.get(node).original, EN)

  assert.equal(restoreApplied(applied), 1)
  assert.equal(node.nodeValue, EN)
  assert.equal(applied.size, 0)
})

test('可逆 · 同一个节点重复翻译不会重复记录', () => {
  const applied = new Map()
  const node = textNode(EN)
  translateTextNode(node, lookup, applied)
  translateTextNode(node, lookup, applied)
  assert.equal(applied.size, 1)
})

test('跳过 · code/pre 内的文本不动', () => {
  const applied = new Map()
  const node = { parentElement: { tagName: 'CODE' }, nodeValue: EN, isConnected: true }
  assert.equal(translateTextNode(node, lookup, applied), false)
  assert.equal(node.nodeValue, EN)
})

/* ---------- Pi 要求：React 重渲染下的四个场景 ---------- */

test('重渲染 A · 节点被 React 改回英文 → 必须重新翻译', () => {
  const applied = new Map()
  const node = textNode(EN)
  translateTextNode(node, lookup, applied)
  assert.equal(node.nodeValue, ZH)

  // React 把这个节点改回了英文
  node.nodeValue = EN
  const again = translateTextNode(node, lookup, applied)
  assert.equal(again, true)
  assert.equal(node.nodeValue, ZH, '开关是开的，英文回来就必须再翻一次')
})

test('重渲染 B · 节点被替换 → 新节点翻译，旧记录被 prune', () => {
  const applied = new Map()
  const oldNode = textNode(EN)
  translateTextNode(oldNode, lookup, applied)
  assert.equal(applied.size, 1)

  // 旧节点脱离 DOM，新节点插进来
  oldNode.isConnected = false
  const newNode = textNode(EN)
  translateTextNode(newNode, lookup, applied)
  assert.equal(newNode.nodeValue, ZH)

  const removed = pruneApplied(applied)
  assert.equal(removed, 1, '脱离 DOM 的旧记录必须被清掉')
  assert.equal(applied.has(oldNode), false)
  assert.equal(applied.has(newNode), true)
})

test('重渲染 C · 节点被复用 → dispose 不得覆盖新文本', () => {
  const applied = new Map()
  const node = textNode(EN)
  translateTextNode(node, lookup, applied)

  // React 复用这个节点装了别的内容
  node.nodeValue = '别的内容'
  const restored = restoreApplied(applied)
  assert.equal(restored, 0, '内容已经不是我们写的，不能还原')
  assert.equal(node.nodeValue, '别的内容', '绝不能把新文本覆盖成旧英文')
  assert.equal(applied.size, 0, '记录仍要清掉')
})

test('重渲染 D · 1000 次替换后记录不会无界增长', () => {
  const applied = new Map()
  let connected = textNode(EN)
  translateTextNode(connected, lookup, applied)

  for (let i = 0; i < 1000; i++) {
    connected.isConnected = false
    connected = textNode(EN)
    translateTextNode(connected, lookup, applied)
    pruneApplied(applied)
    if (applied.size > 2) assert.fail('记录数失控: ' + applied.size)
  }
  assert.ok(applied.size <= 2, '最终记录数应只有当前连接的那个: ' + applied.size)
})

test('开关 · 开→关→开→关 不残留', () => {
  const applied = new Map()
  const node = textNode(EN)

  translateTextNode(node, lookup, applied)
  assert.equal(node.nodeValue, ZH)
  restoreApplied(applied)
  assert.equal(node.nodeValue, EN)

  translateTextNode(node, lookup, applied)
  assert.equal(node.nodeValue, ZH, '再开还能翻')
  restoreApplied(applied)
  assert.equal(node.nodeValue, EN, '再关还能还原')
  assert.equal(applied.size, 0)
})

test('mount · 非中文界面不工作（且 dispose 安全）', () => {
  const handle = mountPluginZh({ locale: 'en' })
  assert.doesNotThrow(() => handle.dispose())
})


/* ---------- Pi 要求：真实 DOM 下的语言守卫 ---------- */

/** 最小 DOM 替身：够 mountPluginZh 走一遍 pass()。 */
function makeDom(initialText) {
  const textNode = {
    nodeType: 3,
    nodeValue: initialText,
    parentElement: { tagName: 'DIV', hasAttribute: () => false },
    isConnected: true,
  }
  let served = false
  const body = {
    nodeType: 1,
    parentElement: null,
    hasAttribute: () => false,
    appendChild: () => {},
  }
  const doc = {
    body,
    createTreeWalker() {
      return {
        nextNode() {
          if (served) return null
          served = true
          return textNode
        },
      }
    },
    createElement: () => ({ style: {}, remove: () => {} }),
    getElementById: () => null,
    addEventListener: () => {},
  }
  return { doc, textNode }
}

test('DOM · locale=en 时，英文文本绝不能被翻成中文', () => {
  const { doc, textNode } = makeDom(EN)
  const handle = mountPluginZh({ locale: 'en', doc, win: undefined })
  assert.equal(textNode.nodeValue, EN, '英文界面必须原样不动')
  assert.equal(handle.state.replaced, 0, '一次替换都不该发生')
  assert.doesNotThrow(() => handle.dispose())
})

test('DOM · locale=zh 时翻译，dispose 后还原', () => {
  const { doc, textNode } = makeDom(EN)
  const handle = mountPluginZh({ locale: 'zh', doc, win: undefined })
  assert.equal(textNode.nodeValue, ZH, '中文界面应翻译')
  assert.ok(handle.state.replaced >= 1)
  const restored = handle.dispose()
  assert.equal(restored, 1)
  assert.equal(textNode.nodeValue, EN, 'dispose 后必须还原英文')
})

test('DOM · locale=en 反复挂载也不影响文本', () => {
  const { doc, textNode } = makeDom(EN)
  for (let i = 0; i < 3; i++) {
    const handle = mountPluginZh({ locale: 'en', doc })
    handle.dispose()
    assert.equal(textNode.nodeValue, EN)
  }
})
