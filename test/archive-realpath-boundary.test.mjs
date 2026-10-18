/**
 * P1：真实文件系统上的边界校验（不是 startsWith 字符串比较）。
 *
 * 用真实的临时目录 + 真实 junction：链接指向根外时必须拒绝。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServiceDeps } from '../src/host/features/archive/service-deps.js'

const fakeAdapter = {
  readArchived: () => [],
  isLive: () => false,
  probe: () => ({ state: 'absent' }),
  unarchive: () => {},
}

function makeTree() {
  const base = mkdtempSync(join(tmpdir(), 'tbx-real-'))
  const home = join(base, 'storages')
  const trash = join(home, 'archive', 'trash')
  const sessions = join(base, 'sessions')
  mkdirSync(trash, { recursive: true })
  mkdirSync(join(sessions, 'projA', 'session-aaaaaaaa-1111-2222-3333-444444444444'), { recursive: true })
  mkdirSync(join(base, 'outside'), { recursive: true })
  writeFileSync(join(base, 'outside', 'marker.txt'), 'x')
  const deps = createServiceDeps({ home, adapter: fakeAdapter })
  return { base, home, trash, sessions, deps }
}

test('P1 · 垃圾箱内的真实路径通过', () => {
  const { base, trash, deps } = makeTree()
  try {
    mkdirSync(join(trash, 'n1'))
    assert.equal(deps.isInsideTrash(join(trash, 'n1')), true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('P1 · 根外绝对路径被真实解析拒绝', () => {
  const { base, deps } = makeTree()
  try {
    assert.equal(deps.isInsideTrash(join(base, 'outside')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('P1 · 指向根外的 junction 被拒绝（即使它躺在垃圾箱里）', () => {
  const { base, trash, deps } = makeTree()
  try {
    const link = join(trash, 'link')
    try {
      symlinkSync(join(base, 'outside'), link, 'junction')
    } catch (error) {
      return // 无权限建链接的环境跳过
    }
    assert.equal(deps.isInsideTrash(link), false, '链接不能算在垃圾箱内')
    assert.equal(deps.isInsideTrash(join(link, 'marker.txt')), false, '穿过链接的路径也不行')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('P1 · 会话目录边界同样按真实路径判断', () => {
  const { base, sessions, deps } = makeTree()
  try {
    assert.equal(
      deps.isInsideSessions(join(sessions, 'projA', 'session-aaaaaaaa-1111-2222-3333-444444444444')),
      true,
    )
    assert.equal(deps.isInsideSessions(join(base, 'outside')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
