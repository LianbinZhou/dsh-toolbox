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
import { SWITCH_KEYS, TRASH_KEPT_DAYS_DEFAULT, TRASH_KEPT_DAYS_MAX, TRASH_KEPT_DAYS_MIN } from '../shared/switches.js'

const shape = {}
for (const key of SWITCH_KEYS) shape[key] = z.boolean().default(key !== 'archiveHttpApi')

// 回收箱保留天数：可配置，7 只是默认值。范围在读取处再夹一次，防止手改配置文件越界。
shape.trashKeptDays = z
  .number()
  .min(TRASH_KEPT_DAYS_MIN)
  .max(TRASH_KEPT_DAYS_MAX)
  .default(TRASH_KEPT_DAYS_DEFAULT)

/**
 * The shipping defaults, as plain data. `archiveHttpApi` is the one switch that
 * must default to OFF: it opens a network surface.
 */
export const CONFIG_DEFAULTS = Object.freeze({
  ...Object.fromEntries(SWITCH_KEYS.map((key) => [key, key !== 'archiveHttpApi'])),
  trashKeptDays: TRASH_KEPT_DAYS_DEFAULT,
})

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

/**
 * 回收箱保留天数，**每次调用重新读**（配置是热更新的）。
 * 缺失、非法、越界都收敛到合法范围内，绝不让一个坏值决定「删除时机」。
 */
export function readTrashKeptDays(config) {
  const values = readConfig(config)
  const raw = Number(values.trashKeptDays)
  if (!Number.isFinite(raw)) return TRASH_KEPT_DAYS_DEFAULT
  return Math.min(TRASH_KEPT_DAYS_MAX, Math.max(TRASH_KEPT_DAYS_MIN, Math.round(raw)))
}
