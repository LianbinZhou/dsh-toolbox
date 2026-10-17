/**
 * The PRE-S3 implementation, kept as the defendant.
 *
 * Copied faithfully from `dsh-plugins/dsh-draft-saver/client.js` (`installGuard`,
 * the version that patched `Storage.prototype`). It exists for one reason: the
 * S3 safety matrix must be able to show that these tests FAIL against the old
 * design. `tools/prove-red.mjs` runs the same matrix through this installer.
 *
 * Every deliberate flaw is annotated in place; they are the six things S3 fixes.
 */

const BACKUP_KEY = 'dsh-draft-saver.backup.v1'
const DRAFT_PREFIX = 'dsh.conversation.'
const EMPTY_DRAFT = JSON.stringify({ draft: { text: '', references: [] }, view: null, viewRequest: null })

function readDraft(value) {
  try {
    const parsed = JSON.parse(value)
    const draft = parsed && parsed.draft
    if (!draft || typeof draft !== 'object') return { ok: false }
    return { ok: true, text: typeof draft.text === 'string' ? draft.text : '' }
  } catch (error) {
    return { ok: false }
  }
}

function draftTextOf(raw) {
  const parsed = readDraft(raw)
  return parsed.ok ? parsed.text : ''
}

/**
 * Build one independent legacy installer (one "module instance").
 *
 * Two calls model the double-eval / HMR case: each closure has its own
 * `uninstallGuard` slot, so both think they are the only one patching.
 */
export function createLegacyInstaller() {
  let uninstallGuard = null

  return function installLegacy(world, options = {}) {
    const { onRestore } = options
    const localStorage = world.localStorage
    globalThis.localStorage = localStorage

    if (uninstallGuard) return { dispose: uninstallGuard, used: 'singleton' }

    GLOBAL_SLOT.value = localStorage

    // FLAW 1: patches Storage.prototype, so sessionStorage is intercepted too.
    const proto = Object.getPrototypeOf(localStorage)
    const origGet = proto.getItem
    const origSet = proto.setItem

    function backupRead() {
      try {
        const raw = origGet.call(GLOBAL_SLOT.value, BACKUP_KEY)
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
        origSet.call(GLOBAL_SLOT.value, BACKUP_KEY, JSON.stringify(record))
      } catch (error) {
        /* swallow */
      }
    }

    const lastRead = new Map()

    function onWrite(key, value) {
      const parsed = readDraft(value)
      if (!parsed.ok) return
      const seen = lastRead.get(key)
      const text = parsed.text
      const existing = backupRead()
      if (text.trim() !== '') {
        if (typeof seen === 'string' && draftTextOf(seen) === text) return
        if (existing && existing.key === key && existing.raw === value) return
        backupWrite({ v: 1, at: Date.now(), key, raw: value, chars: text.length, preview: text.slice(0, 40) })
        return
      }
      if (text === '') backupWrite({ v: 1, at: Date.now(), key, raw: EMPTY_DRAFT, chars: 0, preview: '' })
    }

    function decideRead(key, raw) {
      const backup = backupRead()
      if (!backup) return raw
      const newest = draftTextOf(backup.raw)
      const own = raw === null ? '' : draftTextOf(raw)
      if (own === newest) return raw
      if (newest.trim() === '') return own.trim() === '' ? raw : backup.raw
      // FLAW 5: no `active` check before publishing.
      if (typeof onRestore === 'function') {
        try {
          onRestore({ chars: backup.chars, preview: backup.preview, text: newest })
        } catch (error) {
          /* ignore */
        }
      }
      return backup.raw
    }

    function onRead(key, raw) {
      const answer = decideRead(key, raw)
      if (lastRead.size > 512) lastRead.clear()
      lastRead.set(key, answer)
      return answer
    }

    // FLAW 2: the wrapper has no `active` flag and no PATCH_MARK.
    // FLAW 3: `this` is ignored for the draft decision (no instanceof check).
    proto.setItem = function patchedSetItem(key, value) {
      const result = origSet.call(this, key, value)
      const name = String(key)
      if (name.startsWith(DRAFT_PREFIX)) {
        try {
          onWrite(name, String(value))
        } catch (error) {
          /* ignore */
        }
      }
      return result
    }

    proto.getItem = function patchedGetItem(key) {
      const raw = origGet.call(this, key)
      const name = String(key)
      if (!name.startsWith(DRAFT_PREFIX)) return raw
      try {
        return onRead(name, raw)
      } catch (error) {
        return raw
      }
    }

    uninstallGuard = () => {
      // FLAW 4: unconditional restore — overwrites any later patch.
      proto.getItem = origGet
      proto.setItem = origSet
      uninstallGuard = null
    }

    return { dispose: uninstallGuard, used: 'patched' }
  }
}

/** The legacy code closed over a bare `localStorage`; this models that global. */
export const GLOBAL_SLOT = { value: undefined }
