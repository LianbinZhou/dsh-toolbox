/**
 * The transactional scope (fix for P0-3 / review 3.5).
 *
 * Every side effect a feature creates has to be registered here BEFORE the
 * container trusts the feature. Two consequences the tests pin down:
 *
 *   1. A `mount` that throws half way is rolled back: the effects it already
 *      registered are undone, in reverse order, each in its own try/catch.
 *   2. One throwing disposer never stops the others from running, and `dispose`
 *      is idempotent, so a double teardown cannot undo somebody else's restore.
 *
 * `track` accepts a plain disposer function, a Cordis fiber (`{ dispose() }`,
 * which is what `ctx.inject(...)` and `ctx.effect(...)` return), or nothing.
 */

function toDisposer(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'function') return value
  if (typeof value.dispose === 'function') return () => value.dispose()
  throw new TypeError('dsh-toolbox: a disposer must be a function or expose dispose()')
}

export function createScope(label = 'scope') {
  const undo = []
  let closed = false

  return {
    label,

    /** Register one disposer. Returns it unchanged so callers can keep a handle. */
    track(value) {
      const disposer = toDisposer(value)
      if (disposer === null) return value
      if (closed) {
        // Registering after teardown must undo immediately, never accumulate.
        try {
          disposer()
        } catch (error) {
          console.error('[dsh-toolbox] late disposer failed', error)
        }
        return value
      }
      undo.push(disposer)
      return value
    },

    /** How many effects are currently held. Used by the tests. */
    size() {
      return undo.length
    },

    /** Undo everything, newest first, each isolated. Idempotent. */
    dispose() {
      if (closed) return
      closed = true
      const pending = undo.splice(0).reverse()
      let first
      for (const disposer of pending) {
        try {
          disposer()
        } catch (error) {
          if (first === undefined) first = error
          console.error('[dsh-toolbox] disposer failed in ' + label, error)
        }
      }
      if (first !== undefined) throw first
    },
  }
}
