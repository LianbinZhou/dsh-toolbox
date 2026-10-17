/**
 * Feature: draft-saver (S3 complete).
 *
 * Two halves, both owned by this mount:
 *   1. the storage guard (`draft-guard.js`) — the security-relevant part, covered
 *      by the A–F matrix;
 *   2. the notice strip (`draft-notice.js`) — because a restoration with no UI is
 *      indistinguishable from a bug.
 *
 * Constraint 8: the notice bus is created HERE, per mount. Turning the switch off
 * and on again starts with no notice, no timer and no listener.
 */

import { installDraftGuard } from './draft-guard.js'
import { createNoticeBus, mountNotice, previewOf } from './draft-notice.js'

/**
 * Mount the feature.
 * @param ctx - the client plugin context (locale + slots)
 * @param env - the container environment; `env.track` owns every disposer
 * @returns the disposer (also tracked by the container)
 */
export function mount(ctx, env) {
  const bus = createNoticeBus()

  const getStorage = () => {
    try {
      return typeof window !== 'undefined' ? window.localStorage : undefined
    } catch (error) {
      return undefined
    }
  }

  const handle = installDraftGuard(getStorage, {
    onRestore: (notice) => {
      // The guard reports a restoration; the strip is what makes it visible.
      bus.publish({
        at: notice.at,
        chars: notice.chars,
        text: notice.text ?? '',
        preview: notice.preview || previewOf(notice.text ?? ''),
      })
    },
  })

  if (handle.status !== 'patched') {
    console.warn('[dsh-toolbox] draft guard not active: ' + handle.status + (handle.reason ? ' (' + handle.reason + ')' : ''))
  } else {
    mountNotice(ctx, env, bus)
  }

  // E2E diagnostic: proves in the browser console whether the guard is live and
  // what it did, instead of inferring it from `localStorage.setItem` identity.
  try {
    if (typeof window !== 'undefined') {
      window.__DSH_TOOLBOX_DRAFT__ = {
        status: handle.status,
        patched: handle.patched,
        mode: handle.mode,
        notice: () => bus.get(),
        active: () => handle.active,
        ownSetItem: () => Object.prototype.hasOwnProperty.call(window.localStorage, 'setItem'),
      }
    }
  } catch (error) {
    /* a diagnostic must never break mounting */
  }

  const dispose = () => {
    try {
      bus.dispose()
    } catch (error) {
      console.error('[dsh-toolbox] draft notice dispose failed', error)
    }
    try {
      handle.dispose()
    } catch (error) {
      console.error('[dsh-toolbox] draft guard dispose failed', error)
    }
    try {
      if (typeof window !== 'undefined' && window.__DSH_TOOLBOX_DRAFT__) delete window.__DSH_TOOLBOX_DRAFT__
    } catch (error) {
      /* ignore */
    }
  }

  env.track(dispose)
  return dispose
}
