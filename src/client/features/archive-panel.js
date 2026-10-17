/**
 * S4-c · the archive panel as a container feature.
 *
 * It registers ONE row in `sidebar.panellist` (the same slot the native panel
 * rows use, so `panel-menu` sees it through the slot ledger with no DOM selector
 * to keep in sync) and ONE overlay in `shell.overlay` for the list itself.
 *
 * The previous plugin injected a plain DOM row (`class="dsham-entry"`) that
 * `panel-menu` had to special-case. That coupling is gone: nothing here writes a
 * class the menu has to know about.
 */

import { createArchiveClient } from './archive-client.js'
import { createArchivePanel } from './archive-panel-model.js'
import { cacheSwitches } from '../switches.js'

export const PANEL_SLOT = 'sidebar.panellist'
export const OVERLAY_SLOT = 'shell.overlay'

/** Is the experimental HTTP api switched on right now? Fails closed. */
export function archiveApiEnabled() {
  try {
    const values = cacheSwitches()
    return values?.archiveHttpApi === true
  } catch (error) {
    return false
  }
}

export function mount(ctx, env) {
  const h = env.h
  const slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : null)
  if (!slots || typeof slots.register !== 'function') {
    throw new Error('dsh-toolbox: the slots service is unavailable')
  }

  const client = createArchiveClient({
    // Bound once: the client never reaches for a global itself.
    fetchImpl: (url, init) => fetch(url, init),
  })
  const panel = createArchivePanel({ client, isEnabled: archiveApiEnabled })

  // The overlay is only rendered while it is open; no timers, no observers.
  let open = false
  const listeners = new Set()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const toggle = () => {
    open = !open
    notify()
    if (open) void panel.refresh()
  }

  const row = slots.register({ name: PANEL_SLOT, key: 'dsh-toolbox#archive' }, () =>
    h('button', { type: 'button', class: 'dsh-toolbox-archive-row', onClick: toggle }, '历史归档'),
  )
  env.track(typeof row === 'function' ? row : () => row?.dispose?.())

  const overlay = slots.register({ name: OVERLAY_SLOT, key: 'dsh-toolbox#archive-overlay' }, () => {
    if (!open) return null
    const view = panel.view()
    return h('div', { class: 'dsh-toolbox-archive' }, [
      h('header', null, [h('strong', null, '历史归档'), h('button', { type: 'button', onClick: toggle }, '关闭')]),
      view.state === 'disabled' ? h('p', null, view.message) : null,
      view.message ? h('p', { class: 'dsh-toolbox-archive-error' }, view.message) : null,
      h(
        'ul',
        null,
        view.rows.map((rowView) =>
          h('li', { key: rowView.id }, [
            h('span', null, rowView.label),
            h('button', { type: 'button', disabled: !view.canDelete, onClick: () => void panel.unarchive(rowView.id) }, '恢复'),
            h('button', { type: 'button', disabled: !view.canDelete, onClick: () => void panel.remove(rowView.id) }, '删除'),
          ]),
        ),
      ),
    ])
  })
  env.track(typeof overlay === 'function' ? overlay : () => overlay?.dispose?.())

  return () => {
    if (open) {
      open = false
      notify()
    }
    listeners.clear()
    panel.dispose()
  }
}
