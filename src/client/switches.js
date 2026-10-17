/**
 * Switch reading (client half).
 *
 * The values live in the host's settings system and reach the browser through
 * `ctx.configForms` — note: that service is real but is NOT in the Inspect
 * Service catalogue, so it must be read with `ctx.get('configForms')` rather
 * than declared in the plugin's `inject` list.
 *
 * Two rules:
 *   - Reading never throws outward: a missing or late service makes every switch
 *     `undefined`, which the container treats as OFF.
 *   - The cache is a plain snapshot of the last values that were really seen,
 *     tagged with package and row id so a stale entry from another row can never
 *     be applied.
 */

const CACHE_KEY = 'dsh-toolbox.switches.v1'
const ROW_ID = 'toolbox'
const PACKAGE = 'dsh-toolbox'

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

function pickForm(ctx) {
  const forms = formService(ctx)
  if (!forms || typeof forms.get !== 'function') return undefined
  let served = []
  try {
    const snapshot = forms.describe().getSnapshot()
    served = ((snapshot && snapshot.view && snapshot.view.namespaces) || []).map((entry) => entry.ns)
  } catch (error) {
    served = []
  }
  const id = candidateIds().find((candidate) => served.includes(candidate)) ?? ROW_ID
  try {
    return { form: forms.get(id), entryId: id }
  } catch (error) {
    return undefined
  }
}

/** Plain values from the settings form; `{}` when nothing is readable yet. */
export function readSwitches(ctx) {
  return new Promise((resolve) => {
    let tries = 0
    const attempt = () => {
      const picked = pickForm(ctx)
      if (picked && picked.form && typeof picked.form.getSnapshot === 'function') {
        try {
          const value = picked.form.getSnapshot().value
          if (value && typeof value === 'object') {
            resolve(Object.assign({}, value))
            return
          }
        } catch (error) {
          /* fall through to retry */
        }
      }
      tries += 1
      if (tries >= 20) {
        resolve({})
        return
      }
      setTimeout(attempt, 250)
    }
    attempt()
  })
}

/** Follow settings changes; returns a disposer. */
export function watchSwitches(ctx, callback) {
  const picked = pickForm(ctx)
  if (!picked || !picked.form || typeof picked.form.subscribe !== 'function') return () => {}
  try {
    const off = picked.form.subscribe(() => {
      try {
        const value = picked.form.getSnapshot().value
        if (value && typeof value === 'object') callback(Object.assign({}, value))
      } catch (error) {
        /* ignore a snapshot that is momentarily unavailable */
      }
    })
    return typeof off === 'function' ? off : () => {}
  } catch (error) {
    return () => {}
  }
}

/** Last values really seen, tagged so a foreign row can never be replayed. */
export function cacheSwitches() {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.package !== PACKAGE || parsed.rowId !== ROW_ID) return {}
    return parsed.values && typeof parsed.values === 'object' ? parsed.values : {}
  } catch (error) {
    return {}
  }
}

export function storeSwitches(values) {
  try {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ package: PACKAGE, rowId: ROW_ID, values: values || {} }),
    )
  } catch (error) {
    /* a full or blocked storage must never break the container */
  }
}
