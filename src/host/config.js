/**
 * Host config (fix for P0-1).
 *
 * The shape is a SINGLE root-object volatile: `.volatile()` is applied to the
 * whole `Schema.object(...)`, exactly like the shipped `dsh-client-auto-continue`
 * does. Consequences, measured on this machine:
 *
 *     const Config = Shape.volatile()
 *     config.get()         // { sessionSearch: true, ... }   <- the values
 *     config.sessionSearch // undefined                       <- NOT a boolean
 *     config.sessionSearch.get()  // TypeError                <- the v2 bug
 *
 * So every read goes through `readConfig` / `isOn` below, and the destructured
 * form is banned: `const { sessionSearch } = config` silently caches undefined.
 * A root volatile ref also changes in place on toggle, so a cached destructure
 * would freeze the value forever.
 */

import z from '@deepseek-ai/schemastery'

export const CLIENT_FEATURE_KEYS = ['quoteReply', 'draftSaver', 'panelMenu', 'archivePanel', 'pluginZh']

const Shape = z.object({
  quoteReply: z.boolean().default(true),
  draftSaver: z.boolean().default(true),
  panelMenu: z.boolean().default(true),
  archivePanel: z.boolean().default(true),
  pluginZh: z.boolean().default(true),
  sessionSearch: z.boolean().default(true),
})

/** The row's schema. `.volatile()` => the form exists and applies live. */
export const Config = Shape.volatile()

/** The current values, for either a volatile ref or a plain object. Never throws. */
export function readConfig(config) {
  try {
    if (config !== undefined && config !== null && typeof config.get === 'function') {
      return config.get() ?? {}
    }
    return config ?? {}
  } catch (error) {
    console.error('[dsh-toolbox] reading the volatile config failed', error)
    return {}
  }
}

/**
 * One switch, re-read on every call.
 * A missing key falls back to `fallback` (true, matching the schema default).
 */
export function isOn(config, key, fallback = true) {
  const values = readConfig(config)
  const value = values[key]
  return value === undefined ? fallback : value === true
}
