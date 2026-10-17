/**
 * S4-c · the archive panel as a container feature.
 *
 * Registration follows the SHAPE THAT ALREADY WORKS in this repo (quote-reply,
 * the settings card): `ctx.slots.inject(SLOT, () => ctx.slots.register({name, id,
 * order}, Component))`. A bare `slots.register({name, key})` mounts nothing —
 * that was the bug that left the sidebar without an entry.
 *
 * Two slots, one shared store:
 *   sidebar.panellist  the entry row
 *   shell.overlay      the panel itself
 *
 * panel-menu sees the row through the slot ledger, so no DOM class has to exist.
 */

import { h, useSyncExternalStore, useEffect, useState } from '../runtime.js'
import { createArchiveClient } from './archive-client.js'
import { createArchivePanel } from './archive-panel-model.js'
import { cacheSwitches } from '../switches.js'

export const PANEL_SLOT = 'sidebar.panellist'
export const OVERLAY_SLOT = 'shell.overlay'
export const ROW_ID = 'dsh-toolbox#archive'
export const OVERLAY_ID = 'dsh-toolbox#archive-overlay'

/** Is the experimental HTTP api switched on right now? Fails closed. */
export function archiveApiEnabled() {
  try {
    return cacheSwitches()?.archiveHttpApi === true
  } catch (error) {
    return false
  }
}

function createOpenStore() {
  let open = false
  const listeners = new Set()
  return {
    isOpen: () => open,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(value) {
      open = value
      for (const listener of listeners) listener()
    },
  }
}

export function mount(ctx, env) {
  if (!ctx.slots || typeof ctx.slots.register !== 'function' || typeof ctx.slots.inject !== 'function') {
    throw new Error('dsh-toolbox: the slots service is unavailable')
  }

  const store = createOpenStore()
  const client = createArchiveClient({ fetchImpl: (url, init) => fetch(url, init) })
  const panel = createArchivePanel({ client, isEnabled: archiveApiEnabled })

  function Row() {
    const open = useSyncExternalStore(store.subscribe, store.isOpen)
    return h(
      'button',
      {
        type: 'button',
        class: 'dsh-toolbox-archive-row',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => store.set(!open),
      },
      '历史归档',
    )
  }

  function Overlay() {
    const open = useSyncExternalStore(store.subscribe, store.isOpen)
    const [tick, setTick] = useState(0)
    const view = panel.view()

    useEffect(() => {
      if (!open) return
      let live = true
      void panel.refresh().then(() => {
        if (live) setTick((value) => value + 1)
      })
      return () => {
        live = false
      }
    }, [open])

    if (!open) return null
    const run = (action) => () => {
      void action().then(() => setTick((value) => value + 1))
    }
    return h('div', { class: 'dsh-toolbox-archive', 'data-tick': tick }, [
      h('header', null, [
        h('strong', null, '历史归档'),
        h('button', { type: 'button', onClick: () => store.set(false) }, '关闭'),
      ]),
      view.state === 'disabled' || view.message ? h('p', { class: 'dsh-toolbox-archive-note' }, view.message) : null,
      h(
        'ul',
        null,
        view.rows.map((row) =>
          h('li', { key: row.id }, [
            h('span', null, row.label),
            h('button', { type: 'button', disabled: !view.canDelete, onClick: run(() => panel.unarchive(row.id)) }, '恢复'),
            h('button', { type: 'button', disabled: !view.canDelete, onClick: run(() => panel.remove(row.id)) }, '删除'),
          ]),
        ),
      ),
    ])
  }

  env.track(ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register({ name: PANEL_SLOT, id: ROW_ID, order: 200 }, Row)))
  env.track(
    ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({ name: OVERLAY_SLOT, id: OVERLAY_ID, order: 200 }, Overlay)),
  )

  return () => {
    store.set(false)
    panel.dispose()
  }
}
