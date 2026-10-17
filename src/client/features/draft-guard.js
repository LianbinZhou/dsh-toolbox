/**
 * The S3 draft guard: instance patch, ownership checks, `active` wrappers.
 *
 * Eight constraints from the S3 safety matrix, and where each one lives:
 *
 *  1. Only the `localStorage` INSTANCE is patched. `Storage.prototype` is never
 *     touched on the default path, so `sessionStorage` and every other same
 *     origin Storage keep their own methods.
 *  2. No prototype patch by default. `allowPrototypeFallback` exists only for an
 *     environment where the instance cannot be patched; that branch installs a
 *     `this` guard so `sessionStorage` still passes straight through.
 *  3. The original methods are captured ONCE at mount, and all backup IO goes
 *     through those originals, so the wrapper can never recurse into itself.
 *  4. Each wrapper carries `active` and `Symbol.for('dsh.draft-saver.patch')`.
 *     After dispose an old reference degrades to a transparent forwarder.
 *  5. Dispose restores only while the current method is still ours. If somebody
 *     patched over us, the restore is skipped and `status` becomes
 *     `'needs-refresh'` instead of silently undoing their work.
 *  6. One mount per storage instance: a second mount reuses the live guard, so a
 *     double mount can never build a wrapper chain.
 *  7. Dispose is idempotent, never throws, never removes `BACKUP_KEY` and never
 *     calls `clear()`.
 *  8. Every piece of mutable state (`lastRead`, the notice callback) belongs to
 *     THIS mount; a later mount starts clean.
 */

export const BACKUP_KEY = 'dsh-draft-saver.backup.v1'
export const DRAFT_PREFIX = 'dsh.conversation.'
export const PATCH_MARK = Symbol.for('dsh.draft-saver.patch')
const MAX_LAST_READ = 512

/** The stored value that means "the shared draft is empty". */
const EMPTY_DRAFT = JSON.stringify({ draft: { text: '', references: [] }, view: null, viewRequest: null })

/** One live guard per storage instance, so a second mount cannot chain. */
const LIVE = new WeakMap()

/** Parse a stored draft value; never throws. */
function readDraftValue(raw) {
  if (typeof raw !== 'string') return { ok: false }
  try {
    const parsed = JSON.parse(raw)
    const draft = parsed && parsed.draft
    if (!draft || typeof draft !== 'object') return { ok: false }
    const text = typeof draft.text === 'string' ? draft.text : ''
    return { ok: true, text, references: Array.isArray(draft.references) ? draft.references : [] }
  } catch (error) {
    return { ok: false }
  }
}

/** The draft text inside a stored value, or '' when unreadable. */
export function draftTextOf(raw) {
  const parsed = readDraftValue(raw)
  return parsed.ok ? parsed.text : ''
}

/** A short preview for the notice strip. */
function previewOf(text) {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : oneLine
}

/** Tag a wrapper so a later mount can recognise it (constraint 4). */
function markPatch(wrapper) {
  try {
    Object.defineProperty(wrapper, PATCH_MARK, { value: true, enumerable: false })
  } catch (error) {
    /* a frozen function still works without the mark */
  }
  return wrapper
}

/**
 * Install the draft guard on one storage instance.
 *
 * @param {() => Storage} getStorage - returns the CURRENT local storage instance
 * @param {object} [options]
 * @param {(notice: object) => void} [options.onRestore] - notice publisher
 * @param {boolean} [options.allowPrototypeFallback] - see constraint 2
 * @returns {{ dispose: Function, status: string, patched: boolean, reused: boolean, mode?: string, reason?: string }}
 */
export function installDraftGuard(getStorage, options = {}) {
  const { onRestore, allowPrototypeFallback = false } = options

  const first = typeof getStorage === 'function' ? getStorage() : getStorage
  if (!first || typeof first.getItem !== 'function' || typeof first.setItem !== 'function') {
    return { dispose() {}, status: 'unavailable', patched: false, reused: false, reason: 'no storage' }
  }

  // Constraint 6: reuse the live guard for this instance.
  const existing = LIVE.get(first)
  if (existing) {
    return {
      dispose() {},
      status: existing.status,
      patched: existing.patched,
      reused: true,
      mode: existing.mode,
      reason: 'already patched by this module',
    }
  }

  // F1: a marked wrapper that is NOT in LIVE belongs to another module instance
  // (HMR, double eval) or an older build. Refuse instead of stacking on it.
  if (first.setItem && first.setItem[PATCH_MARK]) {
    return {
      dispose() {},
      status: 'conflict',
      patched: false,
      reused: false,
      reason: 'a draft guard is already installed on this storage',
    }
  }

  // B4: an unstable localStorage (a fresh object per access) cannot be patched
  // reliably on the instance; detect it instead of patching the wrong object.
  const second = typeof getStorage === 'function' ? getStorage() : first
  const unstable = second !== first

  const original = { getItem: first.getItem, setItem: first.setItem }
  // Whether the method we captured was already an OWN property (a third-party
  // patch, or a previous guard). If so, dispose restores by assignment instead
  // of deleting, so the earlier patch survives (B2).
  const hadOwn = {
    getItem: Object.prototype.hasOwnProperty.call(first, 'getItem'),
    setItem: Object.prototype.hasOwnProperty.call(first, 'setItem'),
  }

  const state = {
    active: true,
    lastRead: new Map(),
    status: 'patched',
  }

  /* Constraint 3: backup IO always through the captured originals. */
  function backupRead() {
    try {
      const raw = original.getItem.call(first, BACKUP_KEY)
      if (raw === null) return null
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null
      if (typeof parsed.raw !== 'string' || typeof parsed.key !== 'string') return null
      return parsed
    } catch (error) {
      return null
    }
  }

  function backupWrite(record) {
    try {
      original.setItem.call(first, BACKUP_KEY, JSON.stringify(record))
    } catch (error) {
      /* quota or private mode: the guard stays out of the way */
    }
  }

  function publish(notice) {
    if (!state.active) return
    if (typeof onRestore !== 'function') return
    try {
      onRestore(notice)
    } catch (error) {
      console.error('[dsh-toolbox] draft notice failed', error)
    }
  }

  function onWrite(key, value) {
    const parsed = readDraftValue(value)
    if (!parsed.ok) return
    const seen = state.lastRead.get(key)
    const text = parsed.text
    const existingBackup = backupRead()
    if (text.trim() !== '') {
      if (typeof seen === 'string' && draftTextOf(seen) === text) return
      if (existingBackup && existingBackup.key === key && existingBackup.raw === value) return
      backupWrite({ v: 1, at: Date.now(), key, raw: value, chars: text.length, preview: previewOf(text) })
      return
    }
    if (text === '') {
      backupWrite({ v: 1, at: Date.now(), key, raw: EMPTY_DRAFT, chars: 0, preview: '' })
    }
  }

  function decideRead(key, raw) {
    const backup = backupRead()
    if (!backup) return raw
    const newest = draftTextOf(backup.raw)
    const own = raw === null ? '' : draftTextOf(raw)
    if (own === newest) return raw
    if (newest.trim() === '') return own.trim() === '' ? raw : backup.raw
    publish({ at: Date.now(), chars: backup.chars, preview: backup.preview, text: newest })
    return backup.raw
  }

  function onRead(key, raw) {
    const answer = decideRead(key, raw)
    if (state.lastRead.size > MAX_LAST_READ) state.lastRead.clear()
    state.lastRead.set(key, answer)
    return answer
  }

  /** Does this call belong to us? (constraint 2's `this` guard) */
  const isMine = (target) => target === first

  /** The set-item wrapper. `invoke` is the function to delegate to. */
  function makeSetItem(invoke) {
    return markPatch(function dshDraftSaverSetItem(key, value) {
      const result = invoke(this, key, value)
      // Constraint 4: a stale wrapper is a transparent forwarder.
      if (!state.active) return result
      const name = String(key)
      if (!name.startsWith(DRAFT_PREFIX)) return result
      try {
        onWrite(name, String(value))
      } catch (error) {
        console.error('[dsh-toolbox] draft mirror failed', error)
      }
      return result
    })
  }

  /** The get-item wrapper. `invoke` is the function to delegate to. */
  function makeGetItem(invoke) {
    return markPatch(function dshDraftSaverGetItem(key) {
      const raw = invoke(this, key)
      if (!state.active) return raw
      const name = String(key)
      if (!name.startsWith(DRAFT_PREFIX)) return raw
      try {
        return onRead(name, raw)
      } catch (error) {
        console.error('[dsh-toolbox] draft restore failed', error)
        return raw
      }
    })
  }

  let mode = 'instance'
  let patched = false
  let protoSetRef
  let protoGetRef
  let protoSetWrapper
  let protoGetWrapper

  const instanceSet = makeSetItem(function (self, key, value) {
    return original.setItem.call(self, key, value)
  })
  const instanceGet = makeGetItem(function (self, key) {
    return original.getItem.call(self, key)
  })

  if (!unstable) {
    // Constraint 1: instance patch, never the prototype.
    try {
      const descriptor = Object.getOwnPropertyDescriptor(first, 'setItem')
      if (descriptor && descriptor.writable === false) throw new TypeError('setItem is not writable')
      first.setItem = instanceSet
      first.getItem = instanceGet
      patched = first.setItem === instanceSet && first.getItem === instanceGet
      if (!patched) throw new TypeError('the instance refused the patch')
    } catch (error) {
      // B3: frozen or non-writable. Undo whatever stuck and report honestly.
      try {
        if (first.setItem === instanceSet) delete first.setItem
        if (first.getItem === instanceGet) delete first.getItem
      } catch (cleanupError) {
        /* ignore */
      }
      state.status = 'unsupported'
      patched = false
    }
  } else if (allowPrototypeFallback) {
    // Constraint 2: the only branch that touches the prototype, with a `this` guard.
    const proto = Object.getPrototypeOf(first)
    protoSetRef = proto.setItem
    protoGetRef = proto.getItem

    protoSetWrapper = makeSetItem(function (self, key, value) {
      return protoSetRef.call(self, key, value)
    })
    protoGetWrapper = makeGetItem(function (self, key) {
      return protoGetRef.call(self, key)
    })

    // The wrappers above act for any receiver; re-wrap once to enforce `this`.
    const guardedSet = markPatch(function dshDraftSaverProtoSetItem(key, value) {
      const result = protoSetRef.call(this, key, value)
      if (!state.active || !isMine(this)) return result
      const name = String(key)
      if (!name.startsWith(DRAFT_PREFIX)) return result
      try {
        onWrite(name, String(value))
      } catch (error) {
        console.error('[dsh-toolbox] draft mirror failed', error)
      }
      return result
    })
    const guardedGet = markPatch(function dshDraftSaverProtoGetItem(key) {
      const raw = protoGetRef.call(this, key)
      if (!state.active || !isMine(this)) return raw
      const name = String(key)
      if (!name.startsWith(DRAFT_PREFIX)) return raw
      try {
        return onRead(name, raw)
      } catch (error) {
        return raw
      }
    })

    try {
      proto.setItem = guardedSet
      proto.getItem = guardedGet
      protoSetWrapper = guardedSet
      protoGetWrapper = guardedGet
      patched = proto.setItem === guardedSet && proto.getItem === guardedGet
      mode = 'prototype'
      if (!patched) state.status = 'unsupported'
    } catch (error) {
      state.status = 'unsupported'
      patched = false
    }
  } else {
    state.status = 'unstable'
  }

  const handle = {
    get status() {
      return state.status
    },
    get active() {
      return state.active
    },
    patched,
    reused: false,
    mode,
    dispose() {
      if (!state.active) return
      state.active = false
      LIVE.delete(first)
      if (!patched) return

      try {
        if (mode === 'instance') {
          // Constraint 5: restore only while it is still ours.
          const ours = first.setItem === instanceSet || first.getItem === instanceGet
          const theirs =
            (first.setItem !== undefined && first.setItem !== instanceSet) ||
            (first.getItem !== undefined && first.getItem !== instanceGet)
          if (theirs) {
            state.status = 'needs-refresh'
            console.warn('[dsh-toolbox] draft guard: a later patch replaced ours; leaving it in place')
            return
          }
          if (!ours) return
          if (first.setItem === instanceSet) {
            if (hadOwn.setItem) first.setItem = original.setItem
            else delete first.setItem
          }
          if (first.getItem === instanceGet) {
            if (hadOwn.getItem) first.getItem = original.getItem
            else delete first.getItem
          }
        } else {
          const proto = Object.getPrototypeOf(first)
          if (proto.setItem !== protoSetWrapper || proto.getItem !== protoGetWrapper) {
            state.status = 'needs-refresh'
            return
          }
          proto.setItem = protoSetRef
          proto.getItem = protoGetRef
        }
      } catch (error) {
        state.status = 'needs-refresh'
        console.error('[dsh-toolbox] draft guard restore failed', error)
      }
      // Constraint 7: never remove BACKUP_KEY, never clear().
    },
  }

  // Only a guard that actually patched can be reused by a later mount.
  if (patched) LIVE.set(first, handle)
  return handle
}

/** Test/tooling helper: forget the live guard for an instance. */
export function forgetGuard(storage) {
  LIVE.delete(storage)
}
