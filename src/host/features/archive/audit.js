/**
 * S4-b · the audit log, hardened against flooding (Pi's review).
 *
 * Without these guards, an unauthenticated caller can:
 *   - grow the log one line per rejected request (disk full),
 *   - put a 10 MB string into `actor` (one line, huge file),
 *   - make the rate-limit map hold one entry per junk id (memory).
 *
 * Four answers, each covered by `test/archive-audit-hardening.test.mjs`:
 *
 *   A. Rejections are AGGREGATED per window into one summary line. A successful
 *      action is still written individually, because those are rare and useful.
 *   B. Storage is bounded: a ring for the memory sink, rotation for the file log.
 *   C. Every string field is truncated before it is written.
 *   D. (the per-id map lives in rpc.js)
 */

import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync } from 'node:fs'
import { dirname } from 'node:path'

/** Fields an audit record may carry. `count` belongs to an aggregated summary. */
export const AUDIT_FIELDS = ['at', 'actor', 'role', 'source', 'action', 'id', 'ok', 'reason', 'warning', 'count']

/** No logged string may exceed this, whatever the caller sends. */
export const MAX_FIELD_LEN = 120

/** The summary line's action name. */
export const SUMMARY_ACTION = 'audit.summary'
/** The summary line's reason code. */
export const SUMMARY_REASON = 'audit-summary'

/** Truncate a logged value. Numbers and booleans pass through untouched. */
export function truncate(value) {
  if (typeof value !== 'string') return value
  return value.length > MAX_FIELD_LEN ? value.slice(0, MAX_FIELD_LEN) : value
}

/** Whitelist AND truncate one record. Spreading the caller's object would leak. */
export function pick(entry) {
  const safe = {}
  for (const field of AUDIT_FIELDS) {
    if (entry && entry[field] !== undefined) safe[field] = truncate(entry[field])
  }
  return safe
}

/**
 * A bounded in-memory sink (a ring). Oldest records are dropped first.
 * @param {Array} [sink]
 * @param {{maxRecords?: number}} [options]
 */
export function createMemoryAudit(sink = [], { maxRecords = 500 } = {}) {
  return function audit(entry) {
    sink.push(pick(entry))
    while (sink.length > maxRecords) sink.shift()
  }
}

/**
 * A rotating file sink: one live file plus one previous generation, so the log is
 * bounded at roughly `2 * maxBytes` no matter what happens.
 * @param {string} file
 * @param {{maxBytes?: number}} [options]
 */
export function createFileAudit(file, { maxBytes = 256 * 1024 } = {}) {
  function size() {
    try {
      return statSync(file).size
    } catch (error) {
      return 0
    }
  }

  return function audit(entry) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const line = JSON.stringify(pick(entry)) + '\n'
      if (size() + Buffer.byteLength(line) > maxBytes) {
        // Rotate: the previous generation is kept, the one before it is dropped.
        try {
          rmSync(file + '.1', { force: true })
        } catch (error) {
          /* ignore */
        }
        let rotated = true
        try {
          renameSync(file, file + '.1')
        } catch (error) {
          rotated = false
        }
        if (!rotated) {
          // Rotation failed (the file is held open). Truncating keeps the log
          // bounded; silently appending forever is what we are fixing.
          try {
            truncateSync(file, 0)
          } catch (error) {
            return
          }
        }
      }
      appendFileSync(file, line, 'utf8')
      try {
        // Audit records are local state; nobody else on the machine needs to read
        // them. (Windows ignores the mode, POSIX honours it.)
        chmodSync(file, 0o600)
      } catch (error) {
        /* best effort */
      }
    } catch (error) {
      // An audit sink must never break a delete.
    }
  }
}

/** Read a JSONL audit log back. Corrupt lines are skipped, never fatal. */
export function readAudit(file) {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch (error) {
          return null
        }
      })
      .filter((record) => record !== null)
  } catch (error) {
    return []
  }
}

/**
 * The writer the RPC uses.
 *
 * `allow()` writes at once. `reject()` only bumps counters; the counters become
 * ONE summary line per window on `flush()` (or automatically when the window
 * rolls). That is what keeps an unauthenticated flood from filling the disk.
 *
 * @param {object} options
 * @param {(record: object) => void} options.sink
 * @param {number} [options.windowMs]
 * @param {() => number} [options.now]
 */
export function createAuditWriter({ sink, windowMs = 60_000, now = () => Date.now() } = {}) {
  if (typeof sink !== 'function') throw new TypeError('dsh-toolbox: createAuditWriter needs a sink')
  let windowStart = now()
  let counts = new Map()
  let total = 0

  function rollIfNeeded(at) {
    if (at - windowStart < windowMs) return
    flush()
    windowStart = at
  }

  function flush() {
    if (total === 0) return
    const reasons = [...counts.keys()].sort().join(',')
    sink({
      at: now(),
      action: SUMMARY_ACTION,
      ok: false,
      reason: SUMMARY_REASON,
      warning: reasons,
      count: total,
    })
    counts = new Map()
    total = 0
  }

  return {
    /** A real action, written immediately (truncated + whitelisted). */
    allow(entry) {
      rollIfNeeded(now())
      sink(pick(entry))
    },
    /** A refused request. Aggregated, never written one per request. */
    reject(entry) {
      const at = entry && Number.isFinite(entry.at) ? entry.at : now()
      rollIfNeeded(at)
      const reason = entry && typeof entry.reason === 'string' ? truncate(entry.reason) : 'unknown'
      counts.set(reason, (counts.get(reason) || 0) + 1)
      total += 1
    },
    flush,
    /** Tests / shutdown hooks. */
    pending: () => total,
  }
}
