/**
 * Feature: the restored-draft notice strip.
 *
 * Ported from `dsh-plugins/dsh-draft-saver/client.js` (the `DraftSaverNotice`
 * component and the notice bus), with the S3 constraint 8 applied: the bus is
 * created per mount, so turning the feature off and on again cannot resurrect a
 * stale notice, a stale timer or a stale listener.
 *
 * The strip explains a restoration that already happened and would otherwise be
 * invisible ("the composer suddenly has text in it"). It retires on its own, and
 * acting on it restarts the timer.
 */

import { h, useEffect, useRef, useState } from '../runtime.js'

export const NS = 'dsh-toolbox.draft-saver'
/** Composer floating layer: a closed entry there is the normal state. */
export const NOTICE_SLOT = 'conversation.input.overlay'
export const NOTICE_ID = 'draft-saver.notice'

const AUTO_DISMISS_MS = 20000

const ZH = {
  notice: '已恢复上次未发送的草稿（{chars} 字）',
  copy: '复制',
  copied: '已复制',
  copyFailed: '复制失败',
  clear: '清空',
  dismiss: '知道了',
  hint: '来自上一个会话、还没发送的内容；你可以直接改、发出去，或点清空丢掉它。',
}

const EN = {
  notice: 'Restored an unsent draft ({chars} chars)',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  clear: 'Clear',
  dismiss: 'Got it',
  hint: 'Text from an earlier session that was never sent; edit it, send it, or clear it away.',
}

export { ZH, EN }

/**
 * Create the per-mount notice bus.
 * @returns {{ get: Function, publish: Function, subscribe: Function, dispose: Function }}
 */
export function createNoticeBus() {
  let current = null
  const listeners = new Set()
  return {
    get() {
      return current
    },
    publish(next) {
      current = next ?? null
      for (const listener of Array.from(listeners)) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-toolbox] draft notice listener failed', error)
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      listeners.clear()
      current = null
    },
  }
}

/** Single-line head of a draft, for the strip's tooltip. */
export function previewOf(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? flat.slice(0, 60) + '…' : flat
}

/**
 * Does this notice belong to the draft currently in the composer?
 *
 * A session slot carries no session id, so the restored text itself is the
 * identity: a different session's composer holds a different draft and stays
 * quiet. `draft === null` means "unknown", which is not the same as an empty
 * draft, and never matches.
 * @param {{text?: string}|null} snapshot
 * @param {string|null} draft
 */
export function isMyNotice(snapshot, draft) {
  return Boolean(
    snapshot &&
      typeof snapshot.text === 'string' &&
      snapshot.text !== '' &&
      draft !== null &&
      typeof draft === 'string' &&
      (draft === snapshot.text || draft.startsWith(snapshot.text)),
  )
}

/**
 * Put text on the clipboard. The async Clipboard API needs a secure context and
 * a user gesture; the hidden-textarea fallback covers what it refuses.
 * @returns {Promise<boolean>} whether the copy landed
 */
export async function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (error) {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '0'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const done = document.execCommand('copy')
    document.body.removeChild(area)
    return done === true
  } catch (error) {
    return false
  }
}

const BUTTON_STYLE = {
  appearance: 'none',
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  padding: '2px 8px',
  borderRadius: '7px',
  cursor: 'pointer',
}

/**
 * Build the strip component for one bus and one dictionary.
 * @param {object} bus - from {@link createNoticeBus}
 * @param {(key: string, params?: object) => string} t - bound translator
 */
export function createNoticeComponent(bus, t) {
  return function DraftSaverNotice(props) {
    const [snapshot, setSnapshot] = useState(bus.get())
    /** '' | 'copied' | 'failed' — shown on the copy button for a moment. */
    const [copied, setCopied] = useState('')
    /** The copy button's reset timer, cleared when the strip unmounts. */
    const copyTimer = useRef(null)

    useEffect(() => {
      return () => {
        if (copyTimer.current) clearTimeout(copyTimer.current)
      }
    }, [])

    useEffect(() => {
      const sync = () => setSnapshot(bus.get())
      const off = bus.subscribe(sync)
      sync()
      return off
    }, [])

    /* Informational: it retires on its own so it never sits on the composer
     * while the user works. Acting on it republishes, which restarts this. */
    useEffect(() => {
      if (!snapshot) return undefined
      const timer = setTimeout(() => bus.publish(null), AUTO_DISMISS_MS)
      return () => clearTimeout(timer)
    }, [snapshot])

    const readInput = props.useInput
    const input = typeof readInput === 'function' ? readInput((state) => state) : null
    /* null means "the draft is unknown", which is not the same as "". */
    const draft = input && typeof input.draft === 'string' ? input.draft : null
    const actions = props.inputActions

    if (!isMyNotice(snapshot, draft)) return null

    const copy = () => {
      copyText(draft).then((done) => {
        setCopied(done ? 'copied' : 'failed')
        // Republishing restarts the strip's own retirement timer.
        bus.publish(Object.assign({}, snapshot))
        if (copyTimer.current) clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopied(''), 1800)
      })
    }

    const clear = () => {
      try {
        if (actions && typeof actions.setDraft === 'function') actions.setDraft('')
      } catch (error) {
        console.error('[dsh-toolbox] clearing the restored draft failed', error)
      }
      bus.publish(null)
    }

    return h(
      'div',
      {
        'data-draft-saver': 'notice',
        style: {
          position: 'fixed',
          left: '50%',
          bottom: '104px',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          maxWidth: 'min(620px, calc(100vw - 32px))',
          padding: '8px 12px',
          borderRadius: '10px',
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
          background: 'var(--dsw-alias-bg-overlay, rgba(28,28,30,0.96))',
          color: 'var(--dsw-alias-label-primary, #f5f5f5)',
          boxShadow: '0 8px 28px rgba(0,0,0,0.3)',
          fontSize: '12.5px',
          lineHeight: '1.4',
          zIndex: 60,
        },
      },
      [
        h(
          'span',
          { key: 'text', title: snapshot.preview || '', style: { flex: '1 1 auto', minWidth: '0' } },
          t('notice', { chars: snapshot.chars }),
        ),
        h('button', { key: 'copy', type: 'button', style: BUTTON_STYLE, title: t('hint'), onClick: copy },
          copied === 'copied' ? t('copied') : copied === 'failed' ? t('copyFailed') : t('copy')),
        h('button', { key: 'clear', type: 'button', style: BUTTON_STYLE, title: t('hint'), onClick: clear }, t('clear')),
        h('button', { key: 'dismiss', type: 'button', style: BUTTON_STYLE, onClick: () => bus.publish(null) }, t('dismiss')),
      ],
    )
  }
}

/**
 * Register the two dictionaries and the composer slot.
 * Every effect is tracked, so the switch removes the strip completely.
 */
export function mountNotice(ctx, env, bus) {
  const t = ctx.locale.bind(NS)
  env.track(ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'draft-saver: zh dictionary'))
  env.track(ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'draft-saver: en dictionary'))
  env.track(
    ctx.effect(
      () =>
        ctx.slots.inject(NOTICE_SLOT, () =>
          ctx.slots.register({ name: NOTICE_SLOT, id: NOTICE_ID, order: 320 }, function DraftSaverNoticeEntry(props) {
            const Notice = createNoticeComponent(bus, t)
            return h(Notice, props)
          }),
        ),
      'draft-saver: restored-draft notice',
    ),
  )
}
