/**
 * Switch reading (client half). Fixes P0-3, P1-1 and P2-3.
 *
 * The values live in the host settings system and reach the browser through
 * `ctx.configForms`. Note: that service is real but is NOT in the Inspect Service
 * catalogue, so it is read with `ctx.get('configForms')` rather than declared in
 * `inject` (declaring a non-catalogued name would stop the plugin activating).
 *
 * Three behaviours the review demanded:
 *
 *   1. **`configForms` may arrive late.** Both the read AND the subscription
 *      retry until it exists. A no-op subscription was the bug that made the
 *      switches work exactly once.
 *   2. **The cache is written.** Every value really seen is stored, tagged with
 *      package and row id, so the next start can pre-mount reversible features.
 *   3. **Retries are cancellable.** A disposed container stops rescheduling
 *      instead of keeping timers alive for five seconds.
 */

const CACHE_KEY = 'dsh-toolbox.switches.v1'
const ROW_ID = 'toolbox'
const PACKAGE = 'dsh-toolbox'
const RETRY_MS = 150
const MAX_RETRIES = 40

function formService(ctx) {
  try {
    return (ctx && typeof ctx.get === 'function' && ctx.get('configForms')) || undefined
  } catch (error) {
    return undefined
  }
}

/** Entry ids this row may be served under, most likely first. */
function candidateIds() {
  return [ROW_ID, PACKAGE + '#' + ROW_ID, PACKAGE]
}

/** Resolve the settings form; `undefined` while the service is not ready. */
export function pickForm(ctx) {
  const forms = formService(ctx)
  if (!forms || typeof forms.get !== 'function') return undefined
  let served = []
  try {
    const snapshot = forms.describe().getSnapshot()
    served = ((snapshot && snapshot.view && snapshot.view.namespaces) || []).map((entry) => entry.ns)
  } catch (error) {
    served = []
  }
  const entryId = candidateIds().find((candidate) => served.includes(candidate)) ?? ROW_ID
  try {
    const form = forms.get(entryId)
    return form ? { form, entryId } : undefined
  } catch (error) {
    return undefined
  }
}

/** Plain values out of a form snapshot. */
export function valuesOf(form) {
  try {
    if (!form || typeof form.getSnapshot !== 'function') return undefined
    const snapshot = form.getSnapshot()
    const value = snapshot && snapshot.value
    return value && typeof value === 'object' ? Object.assign({}, value) : undefined
  } catch (error) {
    return undefined
  }
}

/** Read once, retrying until `configForms` answers. Never rejects. */
export function readSwitches(ctx, options = {}) {
  const { isCancelled = () => false } = options
  return new Promise((resolve) => {
    let tries = 0
    const attempt = () => {
      if (isCancelled()) {
        resolve({})
        return
      }
      const picked = pickForm(ctx)
      const values = picked ? valuesOf(picked.form) : undefined
      if (values) {
        storeSwitches(values)
        resolve(values)
        return
      }
      tries += 1
      if (tries >= MAX_RETRIES) {
        resolve({})
        return
      }
      setTimeout(attempt, RETRY_MS)
    }
    attempt()
  })
}

/**
 * Follow settings changes. Retries the binding until `configForms` exists, so a
 * late service still produces live switches.
 * @returns a disposer that cancels the retry loop and the subscription
 */
export function watchSwitches(ctx, callback, options = {}) {
  const { isCancelled = () => false } = options
  let stopped = false
  let unsubscribe
  let timer

  const stop = () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (typeof unsubscribe === 'function') {
      try {
        unsubscribe()
      } catch (error) {
        /* a broken unsubscribe must not break teardown */
      }
      unsubscribe = undefined
    }
  }

  const bind = () => {
    if (stopped || isCancelled()) return
    const picked = pickForm(ctx)
    if (!picked || typeof picked.form.subscribe !== 'function') {
      timer = setTimeout(bind, RETRY_MS)
      return
    }
    try {
      unsubscribe = picked.form.subscribe(() => {
        const values = valuesOf(picked.form)
        if (!values) return
        storeSwitches(values)
        try {
          callback(values)
        } catch (error) {
          console.error('[dsh-toolbox] switch callback failed', error)
        }
      })
    } catch (error) {
      timer = setTimeout(bind, RETRY_MS)
    }
  }

  bind()
  return stop
}

/** Last values really seen, tagged so a foreign row can never be replayed. */
export function cacheSwitches() {
  try {
    const storage = typeof window !== 'undefined' ? window.localStorage : undefined
    if (!storage) return {}
    const raw = storage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.package !== PACKAGE || parsed.rowId !== ROW_ID) return {}
    return parsed.values && typeof parsed.values === 'object' ? parsed.values : {}
  } catch (error) {
    return {}
  }
}

/** Persist the values (P1-1: this had no caller in S1). */
export function storeSwitches(values) {
  try {
    const storage = typeof window !== 'undefined' ? window.localStorage : undefined
    if (!storage) return
    storage.setItem(CACHE_KEY, JSON.stringify({ package: PACKAGE, rowId: ROW_ID, values: values || {} }))
  } catch (error) {
    /* a full or blocked storage must never break the container */
  }
}
