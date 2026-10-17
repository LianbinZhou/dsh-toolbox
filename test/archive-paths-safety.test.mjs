/**
 * S4-b · archive paths safety matrix (RED FIRST).
 *
 * `paths.js` is the only layer that can delete anything off this machine, so it
 * gets the strictest treatment in the repo: a REAL temporary directory tree, real
 * junctions, and assertions that are allowed to fail on the migrated code.
 *
 * The module is covered elsewhere by the archive panel's behaviour; this file is
 * about one question only: can a request reach something it must never touch?
 *
 * Ranked by blast radius:
 *   S1  the sessions ROOT itself must never be removable
 *   S2  a session id must never make scrubProjcache delete outside the home
 *   S3  ids with Windows-reserved characters never reach the filesystem walk
 *   S4  a junction/symlink pointing outside must be refused both on discovery
 *       and immediately before removal
 *   S5  `../` in an id must resolve to nothing
 *   S6  a path outside the root is refused; a missing path is loud, not silent
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  canonicalSessionId,
  findSessionDir,
  isInside,
  isSafeSessionId,
  removeSessionDir,
  scrubProjcache,
  sessionsRootFor,
} from '../src/host/features/archive/paths.js'

/**
 * A real tree:
 *
 *   <base>/sessions/<project>/session-aaaa1111/   a real session
 *   <base>/sessions/<project>/session-escape      a junction -> <base>/outside
 *   <base>/outside/marker.json                    must survive everything
 *   <base>/storages/session_projcache/sessions/   scrub target
 *   <base>/storages/outside/marker.json           must survive a traversal id
 */
function makeWorld() {
  const base = mkdtempSync(join(tmpdir(), 'tbx-archive-'))
  const sessions = join(base, 'sessions')
  const project = join(sessions, '--proj--')
  const session = join(project, 'session-aaaa1111')
  mkdirSync(session, { recursive: true })
  writeFileSync(join(session, 'session.v4.jsonl.zstd'), 'payload')

  const outside = join(base, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'marker.json'), '{"survive":true}')

  const escape = join(project, 'session-escape')
  let junction = false
  try {
    symlinkSync(outside, escape, 'junction')
    junction = true
  } catch (error) {
    // A machine without junction support skips S4 instead of failing the suite.
    junction = false
  }

  const projSessions = join(base, 'storages', 'session_projcache', 'sessions')
  mkdirSync(projSessions, { recursive: true })
  const projInside = join(base, 'storages', 'outside')
  mkdirSync(projInside, { recursive: true })
  writeFileSync(join(projInside, 'marker.json'), '{"survive":true}')

  return { base, sessions, project, session, outside, escape, junction, projSessions, projInside }
}

/** Remove a temp world without ever following a junction. */
function destroyWorld(world) {
  try {
    if (world.junction && existsSync(world.escape)) unlinkSync(world.escape)
  } catch (error) {
    /* best effort */
  }
  try {
    rmSync(world.base, { recursive: true, force: true })
  } catch (error) {
    /* best effort */
  }
}

test('S1 · the sessions root itself is never removable', () => {
  const world = makeWorld()
  try {
    assert.throws(
      () => removeSessionDir(world.sessions, world.sessions),
      /refus/i,
      'removing <sessions> itself would wipe every session on the machine',
    )
    assert.equal(existsSync(world.sessions), true, 'the sessions root must still exist')
    assert.equal(existsSync(world.session), true, 'and so must the session inside it')
  } finally {
    destroyWorld(world)
  }
})

test('S1b · a directory that CONTAINS the sessions root is never removable', () => {
  const world = makeWorld()
  try {
    assert.throws(() => removeSessionDir(world.base, world.sessions), /refus/i)
    assert.equal(existsSync(world.sessions), true)
  } finally {
    destroyWorld(world)
  }
})

test('S2 · a traversing id never makes scrubProjcache delete outside the home', () => {
  const world = makeWorld()
  try {
    const victim = join(world.projInside, 'marker.json')
    assert.equal(existsSync(victim), true, 'the victim file exists before the call')
    scrubProjcache(world.base, ['../../outside/marker'])
    assert.equal(existsSync(victim), true, 'a malformed id must not reach outside the projection cache')
  } finally {
    destroyWorld(world)
  }
})

test('S3 · ids with path-hostile characters are rejected before any walk', () => {
  const hostile = ['a/b', 'a\\b', '..', '../x', 'x/../y', 'x\0y', 'x*y', 'x?y', 'x"y', 'x<y', 'x>y', 'x|y', 'x:y', '']
  for (const id of hostile) {
    assert.equal(isSafeSessionId(id), false, 'must reject ' + JSON.stringify(id))
  }
  assert.equal(isSafeSessionId('session-17d1a0b9-7195-42f5-afe7-df9099dda185'), true, 'a real id is fine')
  assert.equal(isSafeSessionId('17d1a0b9-7195-42f5-afe7-df9099dda185'), true, 'the bare uuid spelling is fine')
})

test('S4 · a junction pointing outside is never found as a session', { skip: false }, () => {
  const world = makeWorld()
  try {
    if (!world.junction) return
    const found = findSessionDir(world.sessions, 'session-escape')
    assert.equal(found, undefined, 'discovery must not hand back a path that resolves outside the root')
  } finally {
    destroyWorld(world)
  }
})

test('S4b · a junction pointing outside is refused immediately before removal', () => {
  const world = makeWorld()
  try {
    if (!world.junction) return
    assert.throws(() => removeSessionDir(world.escape, world.sessions), /refus/i)
    assert.equal(existsSync(join(world.outside, 'marker.json')), true, 'the junction target must survive')
  } finally {
    destroyWorld(world)
  }
})

test('S5 · ../ in an id resolves to nothing', () => {
  const world = makeWorld()
  try {
    assert.equal(findSessionDir(world.sessions, '../../outside'), undefined)
    assert.equal(findSessionDir(world.sessions, '..'), undefined)
    assert.equal(findSessionDir(world.sessions, 'session-aaaa1111/../../outside'), undefined)
  } finally {
    destroyWorld(world)
  }
})

test('S6 · a path outside the root is refused, a missing path is loud', () => {
  const world = makeWorld()
  try {
    assert.throws(() => removeSessionDir(world.outside, world.sessions), /refus/i)
    assert.equal(existsSync(join(world.outside, 'marker.json')), true)

    const missing = join(world.project, 'session-does-not-exist')
    assert.throws(() => removeSessionDir(missing, world.sessions), 'a missing tree must be loud, not silent')
  } finally {
    destroyWorld(world)
  }
})

test('S7 · the happy path still works', () => {
  const world = makeWorld()
  try {
    const found = findSessionDir(world.sessions, 'session-aaaa1111')
    assert.ok(found, 'the real session is found')
    removeSessionDir(found, world.sessions)
    assert.equal(existsSync(world.session), false, 'the session directory is gone')
    assert.equal(existsSync(world.sessions), true, 'but the root is untouched')
  } finally {
    destroyWorld(world)
  }
})

test('S8 · id normalisation is total', () => {
  assert.equal(canonicalSessionId('session-x'), 'session-x')
  assert.equal(canonicalSessionId('x'), 'session-x')
  assert.equal(sessionsRootFor('C:\\h'), join('C:\\h', 'sessions'))
  assert.equal(isInside('C:\\a', 'C:\\a\\b'), true)
  assert.equal(isInside('C:\\a', 'C:\\ab'), false, 'a sibling prefix is not containment')
})
