/**
 * S4-b · the real filesystem tri-state probe (Pi D1 / R5-5 / R5-14).
 *
 * The point of this file is the difference between "it is not there" and "I was
 * not allowed to look". `absent` is the only state that lets the service clear an
 * archive marker, so every ambiguous case must land on `error` or `unsafe`.
 *
 * Real temp trees and real Windows junctions; nothing is mocked.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFsProbe } from '../src/host/features/archive/probe.js'

const ID = 'session-aaaaaaaa-1111-2222-3333-444444444444'

function makeHome() {
  const base = mkdtempSync(join(tmpdir(), 'tbx-probe-'))
  const sessions = join(base, 'sessions')
  const project = join(sessions, '--proj--')
  const session = join(project, ID)
  mkdirSync(session, { recursive: true })
  writeFileSync(join(session, 'session.v4.jsonl.zstd'), 'payload')
  return { base, sessions, project, session }
}

function destroy(home) {
  try {
    rmSync(home.base, { recursive: true, force: true })
  } catch (error) {
    /* best effort */
  }
}

test('a real session directory is present, with a usable identity', () => {
  const home = makeHome()
  try {
    const probe = createFsProbe({ sessionsRoot: home.sessions })
    const result = probe(ID)
    assert.equal(result.state, 'present')
    assert.equal(result.dir, home.session)
    assert.equal(typeof result.identity.dev, 'number')
    assert.equal(typeof result.identity.ino, 'number', 'Windows fills ino; the claim needs it')
    assert.equal(typeof result.identity.realpath, 'string')
  } finally {
    destroy(home)
  }
})

test('a genuinely missing session is absent (cleanup-only is allowed)', () => {
  const home = makeHome()
  try {
    const probe = createFsProbe({ sessionsRoot: home.sessions })
    assert.equal(probe('session-bbbbbbbb-1111-2222-3333-444444444444').state, 'absent')
  } finally {
    destroy(home)
  }
})

test('a MISSING sessions root is an error, not "everything is absent"', () => {
  const home = makeHome()
  try {
    const probe = createFsProbe({ sessionsRoot: join(home.base, 'nope') })
    const result = probe(ID)
    assert.equal(result.state, 'error', 'an unavailable root must never unlock cleanup-only')
  } finally {
    destroy(home)
  }
})

test('a sessions root that is a FILE is an error', () => {
  const home = makeHome()
  try {
    const broken = join(home.base, 'sessions-as-a-file')
    writeFileSync(broken, 'not a directory')
    const probe = createFsProbe({ sessionsRoot: broken })
    assert.equal(probe(ID).state, 'error')
  } finally {
    destroy(home)
  }
})

test('a session directory that is a junction is unsafe, never present', () => {
  const home = makeHome()
  try {
    const outside = join(home.base, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'marker.json'), '{}')
    const link = join(home.project, 'session-cccccccc-1111-2222-3333-444444444444')
    try {
      symlinkSync(outside, link, 'junction')
    } catch (error) {
      return // no junction support on this machine
    }
    const probe = createFsProbe({ sessionsRoot: home.sessions })
    const result = probe('session-cccccccc-1111-2222-3333-444444444444')
    assert.equal(result.state, 'unsafe')
    assert.equal(result.reason, 'link')
  } finally {
    destroy(home)
  }
})

test('a PROJECT directory that is a junction is skipped, and the walk still works', () => {
  const home = makeHome()
  try {
    const outside = join(home.base, 'outside')
    mkdirSync(outside, { recursive: true })
    mkdirSync(join(outside, ID), { recursive: true })
    try {
      symlinkSync(outside, join(home.sessions, '--proxy--'), 'junction')
    } catch (error) {
      return
    }
    const probe = createFsProbe({ sessionsRoot: home.sessions })
    // The real session is still found under the real project.
    assert.equal(probe(ID).state, 'present')
    // A session that only exists behind the junction is absent, not present.
    assert.equal(probe('session-dddddddd-1111-2222-3333-444444444444').state, 'absent')
  } finally {
    destroy(home)
  }
})

test('an unreadable project hides the session: that is an error, not absent', () => {
  const home = makeHome()
  try {
    // A FILE where a project directory is expected: readdirSync throws ENOTDIR,
    // which is the same class of ambiguity as EACCES.
    writeFileSync(join(home.sessions, '--broken--'), 'not a directory')
    const probe = createFsProbe({ sessionsRoot: home.sessions })
    const missing = probe('session-eeeeeeee-1111-2222-3333-444444444444')
    assert.equal(missing.state, 'error', 'a session could be hiding behind the unreadable entry')

    const real = probe(ID)
    assert.equal(real.state, 'present', 'a session that IS found is still found')
  } finally {
    destroy(home)
  }
})

test('a hostile id never reaches the filesystem', () => {
  const home = makeHome()
  try {
    const probe = createFsProbe({ sessionsRoot: home.sessions })
    for (const id of ['../../etc', 'CON', 'a/b', '', 'x'.repeat(300)]) {
      const result = probe(id)
      assert.equal(result.state, 'unsafe', 'rejected before any walk: ' + JSON.stringify(id).slice(0, 30))
    }
  } finally {
    destroy(home)
  }
})
