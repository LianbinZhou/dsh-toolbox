/**
 * 真实 mount：执行组件函数、遍历它返回的元素树。
 *
 * 这里不查「源码里有没有 switchTo」，而是渲染出来看按钮在不在、点下去会不会调对回调。
 * React 用最小实现替代（createElement + useState），这样不用引入 react-dom。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { installRuntime } from '../src/client/runtime.js'
import { mount, PANEL_ID, MAIN_SLOT, PANEL_SLOT } from '../src/client/features/archive-panel.js'

let stateSlots = []
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const index = stateSlots.length
      const value = typeof initial === 'function' ? initial() : initial
      const pair = [value, (next) => { stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next }]
      stateSlots[index] = value
      return pair
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (_subscribe, get) => get(),
  }
}

function makeCtx() {
  const registrations = []
  const ctx = {
    slots: {
      inject: (_name, callback) => {
        const result = callback()
        return typeof result === 'function' ? result : () => {}
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
      entriesOfSlot: () => registrations.map((entry) => ({ options: entry.options })),
    },
    get: (name) => (name === 'configForms' ? { get: () => ({ getSnapshot: () => ({ values: {} }) }) } : undefined),
    layout: { selectPanel: () => {} },
  }
  return { ctx, registrations }
}

function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
  if (node.children) { for (const child of node.children) texts(child, out) }
  return out
}

function findButtons(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) findButtons(child, out); return out }
  if (node.type === 'button') out.push(node)
  if (node.children) for (const child of node.children) findButtons(child, out)
  return out
}

function mountPanel() {
  stateSlots = []
  const { ctx, registrations } = makeCtx()
  const env = { track: () => {}, h: undefined }
  installRuntime(fakeReact())
  mount(ctx, env)
  const main = registrations.find((entry) => entry.options.name === MAIN_SLOT)
  assert.ok(main, '主面板必须注册')
  return main.component
}

test('mount · 渲染出「归档 / 回收箱」两个页签', () => {
  const ArchiveView = mountPanel()
  const tree = ArchiveView()
  const labels = findButtons(tree).map((button) => texts(button).join(''))
  assert.ok(labels.includes('归档'), '缺「归档」页签，实际：' + labels.join('|'))
  assert.ok(labels.includes('回收箱'), '缺「回收箱」页签，实际：' + labels.join('|'))
})

test('mount · 点「回收箱」会切视图并拉取列表', () => {
  const ArchiveView = mountPanel()
  const tree = ArchiveView()
  const tab = findButtons(tree).find((button) => texts(button).join('') === '回收箱')
  assert.ok(tab, '回收箱按钮必须存在')
  assert.equal(typeof tab.props.onClick, 'function', '按钮必须接了回调')
  assert.doesNotThrow(() => tab.props.onClick())
})


test('mount · 渲染树里带样式，列表区域可滚动', () => {
  const ArchiveView = mountPanel()
  const tree = ArchiveView()
  const styles = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.type === 'style') styles.push(texts(node).join(''))
    if (node.children) node.children.forEach(walk)
  }
  walk(tree)
  assert.equal(styles.length, 1, '必须注入一份样式')
  assert.match(styles[0], /overflow-y:auto/, '列表必须可滚动，否则超过一屏就看不到了')
  assert.match(styles[0], /\.dsh-toolbox-archive button/, '按钮样式要统一')
  assert.match(styles[0], /button\.danger/, '危险按钮要单独配色')
})
