/**
 * The React runtime bridge (fix for P0-2).
 *
 * Why this file exists
 * --------------------
 * A browser client module is registered by `window.__ModuleLoader__.load({ id, factory })`.
 * The factory receives the loader's own `require`, and React must be taken from
 * there — the page already has exactly one React and a second copy breaks hooks,
 * context and slots.
 *
 * Two ways to get that wrong, both of which this file avoids:
 *
 *   - `import React from 'react'` in a feature: esbuild bundles a second React
 *     (if react is installed) or fails the build.
 *   - With `external: ['react']`, esbuild emits a TOP-LEVEL
 *       `var import_react = __toESM(__require("react"))`
 *     and `__require` throws in the browser: "Dynamic require of react is not supported".
 *
 * So no module imports react. `index.js` receives the loader's `require` under a
 * non-`require` parameter name (esbuild must not treat it as a CommonJS require)
 * and calls `installRuntime(...)`. Everything else reaches React through these
 * late-bound accessors, which read the installed instance at call time.
 */

let runtime

/** Install the page's React once, from the loader's own require. */
export function installRuntime(react) {
  if (react === null || typeof react !== 'object' || typeof react.createElement !== 'function') {
    throw new TypeError('dsh-toolbox: the module loader did not hand over a React runtime')
  }
  runtime = react
  return runtime
}

/** The installed runtime, or a clear failure instead of a confusing undefined. */
export function getRuntime() {
  if (runtime === undefined) throw new Error('dsh-toolbox: runtime not installed yet')
  return runtime
}

export const hasRuntime = () => runtime !== undefined

/* Late-bound accessors: every one resolves at call time. */
export function h(...args) {
  return getRuntime().createElement(...args)
}
export function useState(...args) {
  return getRuntime().useState(...args)
}
export function useEffect(...args) {
  return getRuntime().useEffect(...args)
}
export function useCallback(...args) {
  return getRuntime().useCallback(...args)
}
export function useRef(...args) {
  return getRuntime().useRef(...args)
}
export function useSyncExternalStore(...args) {
  return getRuntime().useSyncExternalStore(...args)
}

/**
 * `React.Fragment`, resolved at call time.
 *
 * It is a VALUE (a symbol), not a hook, so it cannot be a transparent wrapper:
 * call this function where the fragment type is needed, e.g.
 * `h(fragment(), null, [a, b])`.
 */
export function fragment() {
  return getRuntime().Fragment
}
