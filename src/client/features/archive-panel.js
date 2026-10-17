/**
 * S4-c · the archive panel as a MAIN panel.
 *
 * The contract (from `dsh-client-ui-layout` + how `plugin-manager` registers):
 *
 *   - the panel BODY is a `main` slot entry: `slots.register({ name: 'main', key })`
 *   - the sidebar entry is a `sidebar.panellist` row whose key equals that panel id
 *   - clicking it makes the host call `ctx.layout.selectPanel(key)`
 *
 * The first attempt registered only an overlay, so the host had a sidebar row that
 * pointed at a main panel that did not exist:
 *   `layout.selectPanel: main panel "dsh-toolbox#archive" is not registered`
 */

import { h, useEffect, useState } from '../runtime.js'
import { createArchiveClient } from './archive-client.js'
import { createArchivePanel } from './archive-panel-model.js'
import { cacheSwitches, watchSwitches } from '../switches.js'

export const PANEL_ID = 'dsh-toolbox#archive'
export const MAIN_SLOT = 'main'
export const PANEL_SLOT = 'sidebar.panellist'

/** Is the experimental HTTP api switched on right now? Fails closed. */
let liveEnabled = null

export function archiveApiEnabled() {
  try {
    if (liveEnabled !== null) return liveEnabled
    return cacheSwitches()?.archiveHttpApi === true
  } catch (error) {
    return false
  }
}

export function mount(ctx, env) {
  if (!ctx.slots || typeof ctx.slots.register !== 'function' || typeof ctx.slots.inject !== 'function') {
    throw new Error('dsh-toolbox: the slots service is unavailable')
  }

  // A live subscription, so flipping the 7th switch is reflected without a reload.
  env.track(
    watchSwitches(ctx, (values) => {
      liveEnabled = values?.archiveHttpApi === true
      console.info('[dsh-toolbox] switch values =', values)
      console.info('[dsh-toolbox] archiveHttpApi =', liveEnabled)
    }, {}),
  )

  const client = createArchiveClient({ fetchImpl: (url, init) => fetch(url, init) })
  const panel = createArchivePanel({ client, isEnabled: archiveApiEnabled })

  function ArchiveView() {
    const [view, setView] = useState(() => panel.view())
    const [busy, setBusy] = useState(false)

    const sync = () => setView(panel.view())

    useEffect(() => {
      let live = true
      void panel.refresh().then(() => {
        if (live) sync()
      })
      return () => {
        live = false
      }
    }, [])

    const run = (action) => async () => {
      setBusy(true)
      await action()
      if (live()) sync()
      setBusy(false)
    }
    const live = () => true

    return h('div', { class: 'dsh-toolbox-archive' }, [
      h('header', null, [h('strong', null, '历史归档')]),
      view.message ? h('p', { class: 'dsh-toolbox-archive-note' }, view.message) : null,
      view.rows.length === 0 && !view.message ? h('p', null, '没有归档会话') : null,
      h(
        'ul',
        null,
        view.rows.map((row) =>
          h('li', { key: row.id }, [
            h('span', null, row.label),
            h('button', { type: 'button', disabled: busy || !view.canDelete, onClick: run(() => panel.unarchive(row.id)) }, '恢复'),
            h('button', { type: 'button', disabled: busy || !view.canDelete, onClick: run(() => panel.remove(row.id)) }, '删除'),
          ]),
        ),
      ),
    ])
  }

  function SidebarRow() {
    return h(
      'button',
      {
        type: 'button',
        class: 'dsh-toolbox-archive-row',
        onClick: () => {
          try {
            ctx.layout.selectPanel(PANEL_ID)
          } catch (error) {
            console.error('[dsh-toolbox] selecting the archive panel failed', error)
          }
        },
      },
      '历史归档',
    )
  }

  // The body of the panel, in the same slot the plugin manager uses.
  const mainReg = ctx.slots.register({ name: MAIN_SLOT, key: PANEL_ID }, ArchiveView)
  console.info('[dsh-toolbox] registered main panel, disposer =', typeof mainReg)
  if (typeof mainReg === 'function') env.track(mainReg)
  // The sidebar entry that selects it.
  // A LIST slot wants id; the main slot wants key. They are different registries.\n  const rowReg = ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register({ name: PANEL_SLOT, id: PANEL_ID, order: 200, label: '历史归档' }, SidebarRow))
  console.info('[dsh-toolbox] registered panellist row, disposer =', typeof rowReg)
  if (typeof rowReg === 'function') env.track(rowReg)

  // Diagnostics: proves whether this feature mounted and what the slot registry
  // actually holds. Removed on dispose.
  const readEntries = () => {
    try {
      const list = typeof ctx.slots.entriesOfSlot === 'function' ? ctx.slots.entriesOfSlot(PANEL_SLOT) : undefined
      if (!Array.isArray(list)) return 'entriesOfSlot unavailable'
      // Entries carry their registration options; the id lives inside `options`.
      return list.map((entry) => (entry && entry.options ? entry.options.id : entry && (entry.id ?? entry.key)))
    } catch (error) {
      return 'threw: ' + String(error && error.message)
    }
  }
  console.info('[dsh-toolbox] archive panel mounted; panellist entries =', readEntries())
  if (typeof window !== 'undefined') window.__DSH_TOOLBOX_ARCHIVE__ = {
    mounted: true,
    panelId: PANEL_ID,
    mainSlot: MAIN_SLOT,
    listSlot: PANEL_SLOT,
    entries: readEntries,
    open: () => {
      const layout = (typeof ctx.get === 'function' ? ctx.get('layout') : undefined) || ctx.layout
      if (!layout || typeof layout.selectPanel !== 'function') return 'no layout service'
      try {
        layout.selectPanel(PANEL_ID)
        return 'opened'
      } catch (error) {
        return 'threw: ' + String(error && error.message)
      }
    },
    apiEnabled: () => archiveApiEnabled(),
  }

  return () => {
    if (typeof window !== 'undefined' && window.__DSH_TOOLBOX_ARCHIVE__) delete window.__DSH_TOOLBOX_ARCHIVE__
    panel.dispose()
  }
}
