/**
 * A faithful Web Storage fake for the S3 safety matrix.
 *
 * The matrix demands a CLASS with prototype methods and TWO instances sharing
 * one prototype: a single plain object cannot show a prototype patch leaking
 * into `sessionStorage`, and it cannot show whether a wrapper respected `this`.
 */

export class FakeStorage {
  constructor() {
    this._map = new Map()
  }

  getItem(key) {
    const name = String(key)
    return this._map.has(name) ? this._map.get(name) : null
  }

  setItem(key, value) {
    this._map.set(String(key), String(value))
  }

  removeItem(key) {
    this._map.delete(String(key))
  }

  clear() {
    this._map.clear()
  }

  key(index) {
    return Array.from(this._map.keys())[index] ?? null
  }

  get length() {
    return this._map.size
  }
}

export const BACKUP_KEY = 'dsh-draft-saver.backup.v1'
export const DRAFT_PREFIX = 'dsh.conversation.'

/** A fresh world: two instances on one prototype, plus the captured originals. */
export function makeWorld() {
  const localStorage = new FakeStorage()
  const sessionStorage = new FakeStorage()
  const proto = Object.getPrototypeOf(localStorage)
  return {
    localStorage,
    sessionStorage,
    proto,
    Storage: FakeStorage,
    original: {
      getItem: proto.getItem,
      setItem: proto.setItem,
      removeItem: proto.removeItem,
      clear: proto.clear,
    },
  }
}

/** Build a draft JSON value the way the Harness stores it. */
export function draftValue(text) {
  return JSON.stringify({ draft: { text, references: [] }, view: null, viewRequest: null })
}

/** Read the backup record, or null. */
export function readBackup(storage) {
  const raw = storage.getItem(BACKUP_KEY)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch (error) {
    return { __unparsable: true, raw }
  }
}

/** Count own (instance) properties that shadow the prototype pairs. */
export function ownPatchState(storage, names = ['getItem', 'setItem']) {
  const out = {}
  for (const name of names) out[name] = Object.prototype.hasOwnProperty.call(storage, name)
  return out
}
