/**
 * Feature: draft-saver (S3). The storage half.
 *
 * The guard is the security-relevant part and it is covered by the A–F matrix in
 * `test/draft-storage-safety.test.mjs`. This adapter mounts it on the container's
 * terms: resolve the live `localStorage` at mount time, keep the handle on the
 * feature's own scope, and publish a restore notice through a callback the UI can
 * later attach to.
 *
 * NOT ported yet (S3 follow-up): the notice strip component itself. The old
 * bundle owned that UI; this feature currently only restores the draft and emits
 * the notice event. The switch is honest about the storage behaviour, not about
 * the strip.
 */

import { installDraftGuard } from './draft-guard.js'

/**
 * Mount the guard for this feature instance.
 * @param ctx - the client plugin context (unused today; kept for parity)
 * @param env - the container environment; `env.track` owns the disposer
 * @returns the handle's disposer (also tracked by the container)
 */
export function mount(ctx, env) {
  const getStorage = () => {
    try {
      return typeof window !== 'undefined' ? window.localStorage : undefined
    } catch (error) {
      return undefined
    }
  }

  const handle = installDraftGuard(getStorage, {
    onRestore: (notice) => {
      // The strip is not ported yet; surface it so a later UI can subscribe and
      // so the behaviour is observable in the console during E2E.
      try {
        window.dispatchEvent(new CustomEvent('dsh-toolbox:draft-restore', { detail: notice }))
      } catch (error) {
        console.info('[dsh-toolbox] draft restored', notice)
      }
    },
  })

  if (handle.status !== 'patched') {
    console.warn('[dsh-toolbox] draft guard not active: ' + handle.status + (handle.reason ? ' (' + handle.reason + ')' : ''))
  }

  const dispose = () => {
    try {
      handle.dispose()
    } catch (error) {
      console.error('[dsh-toolbox] draft guard dispose failed', error)
    }
  }

  env.track(dispose)
  return dispose
}
