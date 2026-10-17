/**
 * The settings card (fix for P0-2): the six switches on the plugin row page.
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
 * - `ctx.configForms.get(entryId)` — the shared forms service: `getSnapshot()` to
 *   read `{ value }`, `set(key, bool)` to write.
 * - the slot prop `props.form`, whose shape is **`{ state, mutate }`**
 *   (`ConfigPageForm`), NOT a controller: read `state`, write with
 *   `mutate([{ op: 'set', path: [key], value }], revision)`.
 *
 * Rules learned from the Spike and the S1 review
 * ----------------------------------------------
 * - A component that throws blanks the whole slot entry, so every read and write
 *   below is guarded and the card always draws a line.
 * - `configForms` can arrive late, so the binding retries instead of giving up.
 */

import { h, useCallback, useEffect, useState } from './runtime.js'
import { SWITCHES } from '../shared/switches.js'
import { pickForm, valuesOf, storeSwitches } from './switches.js'

const SLOT = 'plugins.row.config'
const SLOT_KEY = 'dsh-toolbox#toolbox'
const RETRY_MS = 150
const MAX_RETRIES = 40

export { SLOT, SLOT_KEY }

/** Values out of the slot prop's `{ state, mutate }` shape, if it holds any. */
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
    // Two shapes exist in the wild: a controller with getSnapshot(), and a plain
    // snapshot object carrying `revision` directly (ConfigPageForm's `state`).
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

/**
 * Build the card component for one page.
 * @param ctx - the client plugin context (needs `get('configForms')`)
 * @returns a React component for the `plugins.row.config` slot
 */
export function createSettingsCard(ctx) {
  return function SettingsCard(props) {
    const [state, setState] = useState({ status: 'loading', values: undefined, source: '' })
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

    // Bind to a value source; retries while configForms is still missing.
    useEffect(() => {
      let alive = true
      let tries = 0
      let unsubscribe
      let timer

      const apply = (values, source) => {
        if (!alive || !values) return true
        storeSwitches(values)
        setState({ status: 'ready', values, source })
        return true
      }

      const attempt = () => {
        if (!alive) return

        const fromProps = valuesFromPropsForm(props.form)
        if (fromProps && apply(fromProps, 'props.form')) return

        const picked = pickForm(ctx)
        const values = picked ? valuesOf(picked.form) : undefined
        if (values && apply(values, 'configForms')) {
          try {
            unsubscribe = picked.form.subscribe(() => {
              const next = valuesOf(picked.form)
              if (next) apply(next, 'configForms')
            })
          } catch (subscribeError) {
            /* live updates unavailable; the initial values still render */
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
          } catch (error) {
            /* ignore */
          }
        }
      }
    }, [props.form])

    const toggle = useCallback(
      (key, next) => {
        if (busy) return
        setBusy(true)
        setError('')
        try {
          Promise.resolve(writeSwitch(props, ctx, key, next))
            .then((ok) => {
              if (ok === false) setError('服务拒绝了这次写入')
            })
            .catch((writeError) => setError(String((writeError && writeError.message) || writeError)))
            .finally(() => setBusy(false))
        } catch (writeError) {
          setError(String((writeError && writeError.message) || writeError))
          setBusy(false)
        }
      },
      [busy, props, ctx],
    )

    if (props.view === 'summary') {
      const values = state.values
      const on = values ? SWITCHES.filter((entry) => values[entry.key] === true).length : 0
      return h('span', null, on + ' / ' + SWITCHES.length + ' 个开关已开')
    }

    const values = state.values
    const ready = state.status === 'ready'

    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '6px 0' } },
      ...SWITCHES.map((entry, index) =>
        h(
          'label',
          {
            key: entry.key,
            style: { display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: ready ? 'pointer' : 'default' },
          },
          h('input', {
            type: 'checkbox',
            checked: ready ? values[entry.key] === true : false,
            disabled: !ready || busy,
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
