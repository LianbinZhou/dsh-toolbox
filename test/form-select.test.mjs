/**
 * 设置卡片里的「回收箱保留天数」下拉（真实渲染，不是假数据）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { installRuntime } from '../src/client/runtime.js'
import { createSettingsCard } from '../src/client/form.js'
import { TRASH_KEPT_DAYS_OPTIONS } from '../src/shared/switches.js'

function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (_subscribe, get) => get(),
  }
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, predicate, out)); return out }
  if (predicate(node)) out.push(node)
  if (node.children) node.children.forEach((child) => findAll(child, predicate, out))
  return out
}

function makeCtx(values, mutate) {
  const form = {
    getSnapshot: () => ({ value: values, revision: 1 }),
    subscribe: () => () => {},
    mutate,
    set: (key, value) => mutate([{ op: 'set', path: [key], value }], 1),
  }
  return { configForms: { get: () => form, describe: () => ({ getSnapshot: () => ({ entries: [] }) }) }, get: () => undefined }
}

test('表单 · 下拉列出全部可选天数', () => {
  const ctx = makeCtx({ trashKeptDays: 7 }, () => true)
  installRuntime(fakeReact())
  const Card = createSettingsCard(ctx)
  const tree = Card({ view: 'page', form: { state: { getSnapshot: () => ({ value: { trashKeptDays: 7 }, revision: 1 }) }, mutate: () => true } })
  const selects = findAll(tree, (node) => node.type === 'select')
  assert.equal(selects.length, 1, '必须有一个天数下拉')
  const options = findAll(selects[0], (node) => node.type === 'option').map((node) => node.props.value)
  assert.deepEqual(options, TRASH_KEPT_DAYS_OPTIONS.map(String))
})

test('表单 · 选 14 天时 mutate 收到正确的 path 与数值', () => {
  const seen = []
  const ctx = makeCtx({ trashKeptDays: 7 }, (ops, revision) => { seen.push({ ops, revision }); return true })
  installRuntime(fakeReact())
  const Card = createSettingsCard(ctx)
  const tree = Card({ view: 'page', form: { state: { getSnapshot: () => ({ value: { trashKeptDays: 7 }, revision: 1 }) }, mutate: (ops, rev) => { seen.push({ ops, revision: rev }); return true } } })
  const select = findAll(tree, (node) => node.type === 'select')[0]
  assert.ok(select, '下拉必须存在')
  select.props.onChange({ target: { value: '14' } })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].ops, [{ op: 'set', path: ['trashKeptDays'], value: 14 }])
})
