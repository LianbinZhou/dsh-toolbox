/**
 * The transactional scope (fix for P0-3 / P1-5 / P1-6).
 *
 * Every side effect a feature creates is registered here before the container
 * trusts the feature.
 *
 * - A `mount` that throws half way is rolled back: the effects it already
 *   registered run in reverse order, each in its own try/catch.
 * - One throwing disposer never stops the others, and `dispose` is idempotent.
 * - A Cordis fiber disposes ASYNCHRONOUSLY. `dispose()` therefore collects those
 *   promises (each already `.catch`ed) and returns a promise, so a caller can
 *   await the teardown and no rejection is left unhandled.
 * - The same disposer registered twice runs once: a `WeakSet` de-duplicates by
 *   identity, so "returned a disposer AND env.track'ed it" is safe.
 */

function toDisposer(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'function') return value
  if (typeof value.dispose === 'function') return () => value.dispose()
  throw new TypeError('dsh-toolbox: a disposer must be a function or expose dispose()')
}

export function createScope(label = 'scope') {
  const undo = []
  const seen = new WeakSet()
  let closed = false

  /** Run one disposer; collect a returned promise instead of dropping it. */
  function run(disposer, pending) {
    const result = disposer()
    if (result && typeof result.then === 'function') {
      pending.push(
        Promise.resolve(result).catch((error) => {
          console.error('[dsh-toolbox] async disposer failed in ' + label, error)
        }),
      )
    }
  }

  return {
    label,

    /** Register one disposer. Returns it unchanged so callers can keep a handle. */
    track(value) {
      const disposer = toDisposer(value)
      if (disposer === null) return value

      if (closed) {
        // Registering after teardown must undo immediately, never accumulate.
        const sink = []
        try {
          run(disposer, sink)
        } catch (error) {
          console.error('[dsh-toolbox] late disposer failed in ' + label, error)
        }
        return value
      }

      if (seen.has(disposer)) return value
      seen.add(disposer)
      undo.push(disposer)
      return value
    },

    /** How many effects are currently held. Used by the tests. */
    size() {
      return undo.length
    },

    /**
     * Undo everything, newest first, each isolated.
     * @returns a promise that settles when the asynchronous disposers are done
     */
    dispose() {
      if (closed) return Promise.resolve()
      closed = true
      const pending = []
      let first
      for (const disposer of undo.splice(0).reverse()) {
        try {
          run(disposer, pending)
        } catch (error) {
          if (first === undefined) first = error
          console.error('[dsh-toolbox] disposer failed in ' + label, error)
        }
      }
      if (first !== undefined) throw first
      return Promise.all(pending)
    },
  }
}
