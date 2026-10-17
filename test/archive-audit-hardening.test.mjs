/**
 * S4-b · log-flooding and OOM hardening (Pi's audit review).
 *
 * The attack: an unauthenticated caller hammers the RPC with junk ids. Without
 * these guards the audit file grows without bound, the rate-limit map grows one
 * entry per id, and a single 10 MB string in `actor` goes straight to disk.
 *
 * Four requirements, one test group each:
 *   A. authentication failures are AGGREGATED, not logged one by one
 *   B. the log is capped (rotation for files, a ring for memory)
 *   C. every logged field is truncated
 *   D. the per-id rate-limit map has a hard capacity
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AUDIT_FIELDS,
  MAX_FIELD_LEN,
  createAuditWriter,
  createFileAudit,
  createMemoryAudit,
  readAudit,
  truncate,
} from '../src/host/features/archive/audit.js'
import { createArchiveRpc, METHODS } from '../src/host/features/archive/rpc.js'
import { createArchiveService } from '../src/host/features/archive/service.js'
import { makeWorld, ID_A } from './support/archive-service-matrix.mjs'

const UI = { id: 'local-ui', role: 'ui', local: true }

/* ---------------------------- C. truncation ---------------------------- */

test('C · a 10 MB field is truncated before it can reach the log', () => {
  const huge = 'x'.repeat(10 * 1024 * 1024)
  assert.ok(truncate(huge).length <= MAX_FIELD_LEN)
  assert.equal(truncate(undefined), undefined)
  assert.equal(truncate(42), 42, 'numbers pass through')
})

test('C · the writer truncates every string field it accepts', () => {
  const records = []
  const writer = createAuditWriter({ sink: (record) => records.push(record) })
  writer.allow({ at: 1, actor: 'a'.repeat(5000), action: METHODS.DELETE, id: ID_A, ok: true, reason: 'r'.repeat(5000) })
  writer.flush()
  assert.ok(records.length >= 1)
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string') assert.ok(value.length <= MAX_FIELD_LEN, key + ' is too long')
    }
  }
})

/* ------------------------- B. bounded storage ------------------------- */

test('B · the memory sink is a ring: it never exceeds its capacity', () => {
  const sink = []
  const audit = createMemoryAudit(sink, { maxRecords: 3 })
  for (let i = 0; i < 100; i++) audit({ at: i, actor: 'x', action: METHODS.DELETE, id: ID_A, ok: true })
  assert.equal(sink.length, 3, 'a hundred records leave three')
  assert.equal(sink[2].at, 99, 'and the newest survive')
})

test('B · the file log rotates instead of growing forever', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-audit-'))
  const file = join(dir, 'audit.jsonl')
  try {
    const audit = createFileAudit(file, { maxBytes: 4096 })
    for (let i = 0; i < 400; i++) {
      audit({ at: i, actor: 'actor-' + i, action: METHODS.DELETE, id: ID_A, ok: true, reason: 'not-archived' })
    }
    assert.ok(existsSync(file), 'the live log exists')
    assert.ok(statSync(file).size <= 4096 + 512, 'the live log stays near the cap, got ' + statSync(file).size)
    assert.ok(existsSync(file + '.1'), 'the previous generation is kept as .1')
    assert.ok(statSync(file + '.1').size <= 4096 + 512, 'and it is capped too')
    assert.ok(readAudit(file).length >= 1, 'the live log is still readable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------- A. aggregate the unauthenticated ------------------ */

test('A · fifty unauthenticated attempts produce ONE summary line', () => {
  const records = []
  const writer = createAuditWriter({ sink: (record) => records.push(record), windowMs: 60_000 })
  for (let i = 0; i < 50; i++) {
    writer.reject({ at: 1000 + i, actor: undefined, action: METHODS.DELETE, ok: false, reason: 'unauthenticated' })
  }
  writer.flush()
  assert.ok(records.length <= 2, 'fifty rejections must not become fifty lines, got ' + records.length)
  const summary = records.find((record) => record.reason === 'audit-summary' || record.count !== undefined)
  assert.ok(summary, 'a summary record is written')
  assert.ok(summary.count >= 50, 'and it counts every rejection')
  for (const key of Object.keys(summary)) assert.ok(AUDIT_FIELDS.includes(key), 'summary field ' + key)
})

test('A · a successful delete is still written individually', () => {
  const records = []
  const writer = createAuditWriter({ sink: (record) => records.push(record) })
  writer.allow({ at: 1, actor: 'local-ui', action: METHODS.DELETE, id: ID_A, ok: true })
  writer.flush()
  assert.equal(records.length, 1)
  assert.equal(records[0].id, ID_A)
})

/* ---------------------- D. the rate-limit map is capped ----------------- */

test('D · the per-id map cannot be blown up by a stream of distinct ids', async () => {
  const { deps } = makeWorld()
  const service = createArchiveService(deps)
  const rpc = createArchiveRpc({ service })
  for (let i = 0; i < 3000; i++) {
    const id = 'session-' + String(i).padStart(8, '0') + '-1111-2222-3333-444444444444'
    await rpc.delete(undefined, id) // unauthenticated: rejected before any IO
  }
  const stats = rpc.stats()
  assert.ok(stats.trackedIds <= (stats.maxTrackedIds || 1024), 'the map stays bounded, got ' + stats.trackedIds)
  assert.equal(typeof stats.maxTrackedIds, 'number')
})

test('D · unauthenticated calls never reach the service or the filesystem', async () => {
  const { deps, world } = makeWorld()
  const rpc = createArchiveRpc({ service: createArchiveService(deps) })
  for (let i = 0; i < 10; i++) await rpc.delete(undefined, ID_A)
  assert.equal(world.calls.probe.length, 0)
})

/* ------------------------ the file writer + RPC ------------------------ */

test('the RPC writes ONE aggregated line for a flood of unauthorized calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbx-flood-'))
  const file = join(dir, 'audit.jsonl')
  try {
    const { deps } = makeWorld()
    const writer = createAuditWriter({ sink: createFileAudit(file), windowMs: 60_000 })
    const rpc = createArchiveRpc({ service: createArchiveService(deps), audit: writer })
    for (let i = 0; i < 200; i++) await rpc.delete({ id: 'pad', role: 'remote' }, ID_A)
    writer.flush()
    const lines = readAudit(file)
    assert.ok(lines.length <= 3, '200 forbidden attempts must not be 200 lines, got ' + lines.length)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
