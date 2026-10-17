/**
 * Host config (fix for P0-1 / P1-2).
 *
 * The shape is a SINGLE root-object volatile, exactly like the shipped
 * `dsh-client-auto-continue`. Measured on this machine:
 *
 *     const Config = Shape.volatile()
 *     config.get()                // { sessionSearch: true, ... }   <- the values
 *     config.sessionSearch        // undefined                       <- NOT a boolean
 *     config.sessionSearch.get()  // TypeError                       <- the v2 bug
 *
 * So every read goes through `readConfig` / `isOn`, and destructuring is banned:
 * a root volatile ref is updated in place, so a cached destructure freezes the
 * value forever.
 *
 * **Fail closed**: a missing key, an unreadable config or a thrown getter all
 * answer `false`. Earlier versions defaulted to `true`, which meant a broken
 * settings read left every feature switched on.
 */

import z from '@deepseek-ai/schemastery'
import { SWITCH_KEYS } from '../shared/switches.js'

const shape = {}
for (const key of SWITCH_KEYS) shape[key] = z.boolean().default(true)

/** The row's schema. `.volatile()` => the settings form exists and applies live. */
export const Config = z.object(shape).volatile()

/** The current values, for either a volatile ref or a plain object. Never throws. */
export function readConfig(config) {
  try {
    if (config !== undefined && config !== null && typeof config.get === 'function') {
      const values = config.get()
      return values && typeof values === 'object' ? values : {}
    }
    return config && typeof config === 'object' ? config : {}
  } catch (error) {
    console.error('[dsh-toolbox] reading the volatile config failed', error)
    return {}
  }
}

/**
 * One switch, re-read on every call, **fail closed**.
 * @param config - volatile ref or plain object
 * @param key - switch key
 * @param fallback - only pass `true` where "on" is genuinely the safe default
 */
export function isOn(config, key, fallback = false) {
  const values = readConfig(config)
  const value = values[key]
  return value === undefined ? fallback : value === true
}
