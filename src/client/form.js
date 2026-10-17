/**
 * The settings card (fix for P0-2, plus the "everything greys out" UX defect).
 *
 * Where it renders
 * ----------------
 * There is no "configure" button. The plugin manager renders the row detail page
 * and embeds this slot inline:
 *
 *     <div data-plugin-config>
 *       renderSlot("plugins.row.config", { view: "page", form }, { entryKey: key })
 *     </div>
 *
 * with `key = <bundle package name>#<row id>`, so a row shows a form only when a
 * client module registers that exact key.
 *
 * Two value sources, both supported
 * ---------------------------------
 * - the slot prop `props.form`, whose shape is **`{ state, mutate }`**
 *   (`ConfigPageForm`): read `state`, write with
 *   `mutate([{ op: 'set', path: [key], value }], revision)`;
 * - `ctx.configForms.get(entryId)`: `getSnapshot()` to read, `set(key, bool)` to write.
 *
 * Switch feedback rules (learned from the first real screenshot)
 * -------------------------------------------------------------
 * The host write takes about a second. The first version used ONE global `busy`
 * flag, so clicking a single switch greyed out all six until the round trip
 * finished — the user reported "整列都会显示灰色停留约 1 秒".
 *
 * Now:
 *   - **per-key** pending: only the switch you clicked is disabled;
 *   - **optimistic value**: the checkbox flips immediately, and the real value
 *     replaces it when the source catches up;
 *   - a rejected write reverts that one switch and shows a message.
 *
 * A component that throws blanks the whole slot entry, so every read and write
 * below is guarded and the card always draws something.
 */

import { h, useCallback, useEffect, useState } from './runtime.js'
import { SWITCHES } from '../shared/switches.js'
import { pickForm, valuesOf, storeSwitches } from './switches.js'

const SLOT = 'plugins.row.config'
const SLOT_KEY = 'dsh-toolbox#toolbox'
const RETRY_MS = 150
const MAX_RETRIES = 40

export { SLOT, SLOT_KEY }

/* ------------------------------------------------------------------ *
 * pure helpers (unit-tested directly)                                 *
 * ------------------------------------------------------------------ */

/**
 * The value a switch should display: the optimistic overlay wins until the
 * source reports the same value.
 * @param values - values from the source, may be undefined
 * @param overlay - per-key optimistic values
 * @param key - switch key
 */
export function resolveValue(values, overlay, key) {
  if (overlay && Object.prototype.hasOwnProperty.call(overlay, key)) return overlay[key] === true
  return !!(values && values[key] === true)
}

/** Only the switch that is being written is disabled; the others stay live. */
export function isSwitchDisabled(ready, pending, key) {
  if (!ready) return true
  return !!(pending && pending[key] === true)
}

/** Drop overlay entries the source has caught up with, so nothing goes stale. */
export function pruneOverlay(overlay, values) {
  if (!overlay) return {}
  if (!values) return overlay
  const out = {}
  for (const key of Object.keys(overlay)) {
    if (values[key] !== overlay[key]) out[key] = overlay[key]
  }
  return out
}

/* ------------------------------------------------------------------ *
 * source adapters                                                      *
 * ------------------------------------------------------------------ */

function valuesFromPropsForm(form) {
  try {
    if (!form || typeof form !== 'object') return undefined
    const state = form.state
    if (!state) return undefined
    if (typeof state.getSnapshot === 'function') {
      const snapshot = state.getSnapshot()
      const value = snapshot && snapshot.value
      if (value && typeof value === 'object') return Object.assign({}, value)
    }
    const value = state.value
    if (value && typeof value === 'object') return Object.assign({}, value)
    return undefined
  } catch (error) {
    return undefined
  }
}

function revisionOf(form) {
  try {
    const state = form && form.state
    if (!state) return undefined
    if (typeof state.getSnapshot === 'function') {
      const snapshot = state.getSnapshot()
      return snapshot && snapshot.revision
    }
    if (typeof state === 'object' && 'revision' in state) return state.revision
  } catch (error) {
    /* ignore */
  }
  return undefined
}

/** Write one switch through whichever source is available. */
function writeSwitch(props, ctx, key, next) {
  const picked = pickForm(ctx)
  if (picked && picked.form && typeof picked.form.set === 'function') {
    return picked.form.set(key, next)
  }
  const form = props && props.form
  if (form && typeof form.mutate === 'function') {
    return form.mutate([{ op: 'set', path: [key], value: next }], revisionOf(form))
  }
  throw new Error('no writable settings form')
}

/* ------------------------------------------------------------------ *
 * the card                                                            *
 * ------------------------------------------------------------------ */

export function createSettingsCard(ctx) {
  return function SettingsCard(props) {
    const [state, setState] = useState({ status: 'loading', values: undefined, source: '' })
    const [overlay, setOverlay] = useState({})
    const [pending, setPending] = useState({})
    const [error, setError] = useState('')

    // Bind to a value source; retries while configForms is still missing.
    useEffect(() => {
      let alive = true
      let tries = 0
      let unsubscribe
      let timer

      const publish = (values, source) => {
        if (!alive || !values) return false
        storeSwitches(values)
        setState({ status: 'ready', values, source })
        setOverlay((previous) => pruneOverlay(previous, values))
        return true
      }

      const attempt = () => {
        if (!alive) return

        const fromProps = valuesFromPropsForm(props.form)
        if (fromProps && publish(fromProps, 'props.form')) return

        const picked = pickForm(ctx)
        const values = picked ? valuesOf(picked.form) : undefined
        if (values && publish(values, 'configForms')) {
          try {
            unsubscribe = picked.form.subscribe(() => {
              const next = valuesOf(picked.form)
              if (next) publish(next, 'configForms')
            })
          } catch (subscribeError) {
            /* live updates unavailable; the values already rendered stay */
          }
          return
        }

        tries += 1
        if (tries < MAX_RETRIES) timer = setTimeout(attempt, RETRY_MS)
        else if (alive) setState({ status: 'unavailable', values: undefined, source: 'none' })
      }

      attempt()
      return () => {
        alive = false
        if (timer !== undefined) clearTimeout(timer)
        if (typeof unsubscribe === 'function') {
          try {
            unsubscribe()
          } catch (unsubscribeError) {
            /* ignore */
          }
        }
      }
    }, [props.form])

    const toggle = useCallback(
      (key, next) => {
        // Optimistic: flip this one switch now; do not touch the others.
        setOverlay((previous) => Object.assign({}, previous, { [key]: next }))
        setPending((previous) => Object.assign({}, previous, { [key]: true }))
        setError('')

        const revert = () => {
          setOverlay((previous) => {
            const copy = Object.assign({}, previous)
            delete copy[key]
            return copy
          })
        }

        try {
          Promise.resolve(writeSwitch(props, ctx, key, next))
            .then((ok) => {
              if (ok === false) {
                revert()
                setError('服务拒绝了这次写入，开关已还原')
              }
            })
            .catch((writeError) => {
              revert()
              setError('写入失败：' + String((writeError && writeError.message) || writeError))
            })
            .finally(() => {
              setPending((previous) => {
                const copy = Object.assign({}, previous)
                delete copy[key]
                return copy
              })
            })
        } catch (writeError) {
          revert()
          setError('写入失败：' + String((writeError && writeError.message) || writeError))
          setPending((previous) => {
            const copy = Object.assign({}, previous)
            delete copy[key]
            return copy
          })
        }
      },
      [props, ctx],
    )

    if (props.view === 'summary') {
      const values = state.values
      const on = values ? SWITCHES.filter((entry) => resolveValue(values, overlay, entry.key)).length : 0
      return h('span', null, on + ' / ' + SWITCHES.length + ' 个开关已开')
    }

    const values = state.values
    const ready = state.status === 'ready'

    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '6px 0' } },
      ...SWITCHES.map((entry) =>
        h(
          'label',
          {
            key: entry.key,
            style: {
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              cursor: ready ? 'pointer' : 'default',
              opacity: pending[entry.key] ? 0.55 : 1,
            },
          },
          h('input', {
            type: 'checkbox',
            checked: resolveValue(values, overlay, entry.key),
            disabled: isSwitchDisabled(ready, pending, entry.key),
            onChange: (event) => {
              const next = !!(event && event.target && event.target.checked)
              toggle(entry.key, next)
            },
            style: { marginTop: '3px' },
          }),
          h(
            'span',
            { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            h('span', { style: { fontSize: '13px' } }, entry.label),
            h('span', { style: { fontSize: '12px', opacity: 0.6 } }, entry.hint),
          ),
        ),
      ),
      h(
        'div',
        { style: { fontSize: '12px', opacity: 0.6 } },
        ready ? '改动立刻生效，不用刷新页面。' : '读取设置中…（' + state.status + '）',
      ),
      error ? h('div', { style: { fontSize: '12px', color: '#c0392b' } }, error) : null,
      h(
        'div',
        { style: { fontSize: '11px', opacity: 0.4, fontFamily: 'ui-monospace, monospace' } },
        SLOT_KEY + ' · ' + (state.source || 'none'),
      ),
    )
  }
}
