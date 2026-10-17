/**
 * S4-b · Pi 的 R1 / R2 / R3 / R7 红线（先写测试）。
 *
 * 与 `archive-paths-safety.test.mjs` 分开：那个文件守的是"根目录不可删"这一层，
 * 这里守的是 Pi 加严后的四条：
 *
 *   R1  只允许删除**严格两级**的目录（<sessionsRoot>/<project>/<segment>）
 *   R2  junction/symlink 即使指向根**内部**也必须拒绝；删除前重新 lstat
 *   R3  id 用 allowlist；设备名、空格、编码、非字符串一律挡
 *   R7  scrubProjcache 不跟随符号链接，index 只动 sessions 表
 *
 * 全部用真实临时目录 + 真实 junction 跑。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  canonicalSessionId,
  findSessionDir,
  isSafeSessionId,
  removeSessionDir,
  scrubProjcache,
} from '../src/host/features/archive/paths.js'

/**
 * <base>/sessions/<project>/
 *   session-real      a real session
 *   session-link      a junction -> session-real   (inside the root!)
 *   session-escape    a junction -> <base>/outside (outside the root)
 *   session-real/nested   a directory INSIDE a session (depth 3)
 */
function makeWorld() {
  const base = mkdtempSync(join(tmpdir(), 'tbx-red-'))
  const sessions = join(base, 'sessions')
  const project = join(sessions, '--proj--')
  const real = join(project, 'session-real')
  mkdirSync(real, { recursive: true })
  writeFileSync(join(real, 'session.v4.jsonl.zstd'), 'payload')
  const nested = join(real, 'nested')
  mkdirSync(nested, { recursive: true })

  const outside = join(base, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'marker.json'), '{"survive":true}')

  let junction = true
  const link = join(project, 'session-link')
  try {
    symlinkSync(real, link, 'junction')
  } catch (error) {
    junction = false
  }
  try {
    symlinkSync(outside, join(project, 'session-escape'), 'junction')
  } catch (error) {
    /* the escape case is covered by the other file */
  }

  const projSessions = join(base, 'storages', 'session_projcache', 'sessions')
  mkdirSync(projSessions, { recursive: true })

  return { base, sessions, project, real, nested, link, outside, junction, projSessions }
}

function destroy(world) {
  for (const link of [world.link, join(world.project, 'session-escape')]) {
    try {
      if (link && existsSync(link)) unlinkSync(link)
    } catch (error) {
      /* best effort */
    }
  }
  try {
    rmSync(world.base, { recursive: true, force: true })
  } catch (error) {
    /* best effort */
  }
}

/* ------------------------------- R1 ------------------------------- */

test('R1a · a directory INSIDE a session (depth 3) is refused', () => {
  const world = makeWorld()
  try {
    assert.throws(
      () => removeSessionDir(world.nested, world.sessions),
      /refus/i,
      'only <root>/<project>/<segment> may be removed, never a child of it',
    )
    assert.equal(existsSync(world.nested), true, 'the nested directory must survive')
    assert.equal(existsSync(join(world.real, 'session.v4.jsonl.zstd')), true, 'and so must the session payload')
  } finally {
    destroy(world)
  }
})

test('R1b · the project level itself is refused (depth 1)', () => {
  const world = makeWorld()
  try {
    assert.throws(() => removeSessionDir(world.project, world.sessions), /refus/i)
    assert.equal(existsSync(world.project), true)
  } finally {
    destroy(world)
  }
})

test('R1c · the exact two-level session directory is still removable', () => {
  const world = makeWorld()
  try {
    removeSessionDir(world.real, world.sessions)
    assert.equal(existsSync(world.real), false)
    assert.equal(existsSync(world.project), true, 'the project directory stays')
  } finally {
    destroy(world)
  }
})

/* ------------------------------- R2 ------------------------------- */

test('R2a · a junction pointing at ANOTHER session inside the root is not discovered', () => {
  const world = makeWorld()
  try {
    if (!world.junction) return
    assert.equal(
      findSessionDir(world.sessions, 'session-link'),
      undefined,
      'a link is not a session, even when it resolves inside the root',
    )
  } finally {
    destroy(world)
  }
})

test('R2b · a junction pointing at another session is refused, and the target survives', () => {
  const world = makeWorld()
  try {
    if (!world.junction) return
    assert.throws(
      () => removeSessionDir(world.link, world.sessions),
      /refus/i,
      'removing a junction would delete the session it points at',
    )
    assert.equal(existsSync(world.real), true, 'the real session must survive')
    assert.equal(existsSync(join(world.real, 'session.v4.jsonl.zstd')), true, 'with its payload')
  } finally {
    destroy(world)
  }
})

test('R2c · a plain FILE is never removed as a session directory', () => {
  const world = makeWorld()
  try {
    const file = join(world.project, 'not-a-dir.txt')
    writeFileSync(file, 'x')
    assert.throws(() => removeSessionDir(file, world.sessions), /refus/i)
    assert.equal(existsSync(file), true)
  } finally {
    destroy(world)
  }
})

/* ------------------------------- R3 ------------------------------- */

test('R3a · Windows device names are rejected', () => {
  const hostile = ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9', 'CON.txt', 'nul.json']
  for (const id of hostile) {
    assert.equal(isSafeSessionId(id), false, 'must reject the device name ' + id)
  }
})

test('R3b · ids must be an allowlisted shape (uuid or session-uuid)', () => {
  const allowed = [
    'session-17d1a0b9-7195-42f5-afe7-df9099dda185',
    '17d1a0b9-7195-42f5-afe7-df9099dda185',
    'session-00000000-0000-0000-0000-000000000000',
  ]
  for (const id of allowed) {
    assert.equal(isSafeSessionId(id), true, 'must accept ' + id)
  }
  const hostile = [
    'hello world',
    'session-..',
    'session-abc',
    '%2e%2e%2fetc',
    'session-17d1a0b9_7195',
    '  session-17d1a0b9-7195-42f5-afe7-df9099dda185',
    'session-17d1a0b9-7195-42f5-afe7-df9099dda185\n',
    'x'.repeat(300),
  ]
  for (const id of hostile) {
    assert.equal(isSafeSessionId(id), false, 'must reject ' + JSON.stringify(id).slice(0, 40))
  }
})

test('R3c · hostile ids are blocked at all three gates', () => {
  const world = makeWorld()
  try {
    const id = 'CON'
    assert.equal(isSafeSessionId(id), false)
    assert.equal(findSessionDir(world.sessions, id), undefined)
    scrubProjcache(world.base, [id, '../../outside/marker'])
    assert.equal(existsSync(join(world.base, 'outside', 'marker.json')), true)
  } finally {
    destroy(world)
  }
})

test('R3d · canonicalSessionId never throws on a non-string', () => {
  assert.doesNotThrow(() => canonicalSessionId(undefined))
  assert.equal(typeof canonicalSessionId(undefined), 'string', 'it returns a value or an empty string, never throws')
})

/* ------------------------------- R7 ------------------------------- */

test('R7a · scrubProjcache does not follow a symlinked cache file', () => {
  const world = makeWorld()
  try {
    const victim = join(world.base, 'outside', 'marker.json')
    const id = 'session-abcdef12-1111-2222-3333-444444444444'
    const linkName = join(world.projSessions, id + '.json')
    try {
      symlinkSync(victim, linkName)
    } catch (error) {
      return // no symlink support: covered elsewhere
    }
    scrubProjcache(world.base, [id])
    assert.equal(existsSync(victim), true, 'a symlinked cache entry must not delete its target')
    assert.equal(existsSync(linkName), false, 'the cache entry itself is dropped')
  } finally {
    destroy(world)
  }
})

test('R7b · the aggregate index keeps every table except sessions', () => {
  const world = makeWorld()
  try {
    const indexPath = join(world.base, 'storages', 'session_projcache.json')
    const target = 'session-aaaaaaaa-1111-2222-3333-444444444444'
    const keep = 'session-bbbbbbbb-1111-2222-3333-444444444444'
    const index = {
      tables: {
        sessions: { [target]: { title: 'x' }, [keep]: { title: 'y' } },
        workspaces: { keep: true },
        other: { keep: true },
      },
    }
    mkdirSync(dirname(indexPath), { recursive: true })
    writeFileSync(indexPath, JSON.stringify(index), 'utf8')

    scrubProjcache(world.base, [target])
    const after = JSON.parse(readFileSync(indexPath, 'utf8'))
    assert.equal(after.tables.sessions[target], undefined, 'the target row is gone')
    assert.ok(after.tables.sessions[keep], 'the other session row stays')
    assert.deepEqual(after.tables.workspaces, { keep: true }, 'other tables are untouched')
    assert.deepEqual(after.tables.other, { keep: true })
  } finally {
    destroy(world)
  }
})

test('R7c · a corrupt index is left byte-identical', () => {
  const world = makeWorld()
  try {
    const indexPath = join(world.base, 'storages', 'session_projcache.json')
    mkdirSync(dirname(indexPath), { recursive: true })
    const corrupt = '{ this is not json'
    writeFileSync(indexPath, corrupt, 'utf8')
    scrubProjcache(world.base, ['session-aaaa'])
    assert.equal(readFileSync(indexPath, 'utf8'), corrupt, 'a corrupt index must not be rewritten')
  } finally {
    destroy(world)
  }
})
