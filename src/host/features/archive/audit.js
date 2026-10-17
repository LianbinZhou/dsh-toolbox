/**
 * S4-b · persistent audit log (Pi R6 / RPC-8).
 *
 * One JSON object per line, appended. Fields are whitelisted: an actor, an
 * action, an id, an outcome. Never a path, a token, a draft, or an exception
 * message — the audit file is exactly the kind of thing that ends up in a bug
 * report.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The only fields an audit record may carry. */
export const AUDIT_FIELDS = ['at', 'actor', 'role', 'source', 'action', 'id', 'ok', 'reason', 'warning']

/**
 * @param {string} file - absolute path to the JSONL audit log
 */
export function createFileAudit(file) {
  return function audit(entry) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, JSON.stringify(pick(entry)) + '\n', 'utf8')
    } catch (error) {
      // An audit sink must never break a delete; the caller records the outcome
      // in memory too (see createMemoryAudit).
    }
  }
}

/** In-memory audit (tests, and the fallback when no writable dir exists). */
export function createMemoryAudit(sink = []) {
  return function audit(entry) {
    sink.push(pick(entry))
  }
}

/** Whitelist a record. Spreading the caller's object would leak extra fields. */
export function pick(entry) {
  const safe = {}
  for (const field of AUDIT_FIELDS) {
    if (entry && entry[field] !== undefined) safe[field] = entry[field]
  }
  return safe
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
