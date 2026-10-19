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

import { createDshAdapter, callOptional } from '../dsh-adapter.js'
import { h, useEffect, useState } from '../runtime.js'
import { createArchiveClient } from './archive-client.js'
import { createArchivePanel } from './archive-panel-model.js'
import { cacheSwitches, watchSwitches } from '../switches.js'

/**
 * Stylesheet for the archive panel. Injected once per page.
 *
 * Every colour is a host theme token, so light and dark both work and nothing
 * is hard-coded here. Colours used by the previous inline style (`#b3261e`)
 * fought the theme in dark mode, which is why the buttons looked pasted-on.
 */
const ARCHIVE_CSS = `
.dsh-toolbox-archive{display:flex;flex-direction:column;height:100%;min-height:0;padding:16px 18px;gap:10px;color:var(--dsw-alias-label-primary);font-size:13px}
.dsh-toolbox-archive header{flex:none;font-size:15px;font-weight:650;display:flex;align-items:baseline;gap:8px}
.dsh-toolbox-archive-count{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary);opacity:.75}
.dsh-toolbox-archive-note{flex:none;margin:0;color:var(--dsw-alias-label-secondary);opacity:.85;font-size:12px}
.dsh-toolbox-archive-empty{flex:none;margin:0;padding:28px 12px;text-align:center;color:var(--dsw-alias-label-secondary);opacity:.7}
.dsh-toolbox-archive ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin}
.dsh-toolbox-archive li{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;transition:background .15s ease}
.dsh-toolbox-archive li:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-toolbox-archive-title{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-toolbox-archive-title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dsh-toolbox-archive-id{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);opacity:.6;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsh-toolbox-archive button{flex:none;font-family:inherit;font-size:12px;line-height:1;padding:5px 11px;border-radius:7px;cursor:pointer;border:1px solid transparent;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);transition:background .15s ease,color .15s ease,border-color .15s ease}
.dsh-toolbox-archive button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dsh-toolbox-archive button:disabled{opacity:.5;cursor:default}
.dsh-toolbox-archive button.danger{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dsh-toolbox-archive button.danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 15%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 32%,transparent)}
`

/** Install the panel stylesheet exactly once per page. */
export function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById('dsh-toolbox-archive-css') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh-toolbox-archive-css'
  style.dataset.dshToolbox = 'archive'
  style.textContent = ARCHIVE_CSS
  document.head.appendChild(style)
}

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

/**
 * 让 DSH 自己的会话列表重新拉一次。
 *
 * 「未分组」不是 workspace 表算出来的：它是 sessions.list 减去各工作区成员。
 * 删掉目录只改了磁盘，Session 列表还是旧快照——不刷这一步，侧栏那一行就永远在。
 */
export async function refreshHostSessionsOf(ctx, adapter) {
  // 所有官方访问都过防腐层：接口没了只降级（侧栏需要手动刷新），不让插件崩。
  const dsh = adapter ?? createDshAdapter(ctx)
  const sessions = dsh.get('sessions')
  if (sessions === undefined || typeof sessions.refresh !== 'function') return false
  // refresh() 通常没有返回值：没抛就算成功；抛了如实返回 false（侧栏需手动刷新）。
  try {
    await sessions.refresh()
    return true
  } catch (error) {
    console.warn('[dsh-toolbox] sessions.refresh 失败（侧栏可能要手动刷新）', error)
    return false
  }
}

/** 内部状态码 → 给人看的中文（不能把 cleaned/trashed 直接露给用户）。 */
export function phaseLabel(phase) {
  if (phase === 'trashed') return '待清理'
  if (phase === 'cleaned') return '已移入回收箱'
  if (phase === 'done') return '已彻底删除'
  return '处理中'
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

  ensureStyles()

  const client = createArchiveClient({ fetchImpl: (url, init) => fetch(url, init) })
  const panel = createArchivePanel({ client, isEnabled: archiveApiEnabled })

  const PANEL_CSS = [
  '.dsh-toolbox-archive{display:flex;flex-direction:column;height:100%;min-height:0;max-height:100%;overflow:hidden;box-sizing:border-box;padding:14px;gap:10px}',
  '.dsh-toolbox-archive header{display:flex;align-items:baseline;gap:8px;flex:0 0 auto}',
  '.dsh-toolbox-archive-count{color:var(--dsw-alias-text-secondary,#888);font-size:12px}',
  '.dsh-toolbox-archive-tabs{display:flex;gap:6px;flex:0 0 auto}',
  '.dsh-toolbox-archive-tabs button[aria-pressed=\"true\"]{background:var(--dsw-alias-bg-selected,#e8f0fe);border-color:var(--dsw-alias-border-strong,#8ab4f8);font-weight:600}',
  '.dsh-toolbox-archive ul{flex:1 1 auto;min-height:0;max-height:calc(100dvh - 220px);overflow-y:auto;overscroll-behavior:contain;margin:0;padding:0 2px 0 0;list-style:none;display:flex;flex-direction:column;gap:6px}',
  '.dsh-toolbox-archive li{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-1,#e3e3e3);border-radius:8px;background:var(--dsw-alias-bg-1,#fff)}',
  '.dsh-toolbox-archive-title{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
  '.dsh-toolbox-archive-title strong{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-toolbox-archive-id{color:var(--dsw-alias-text-secondary,#999);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-toolbox-archive button{flex:0 0 auto;padding:4px 10px;border:1px solid var(--dsw-alias-border-1,#d5d5d5);border-radius:6px;background:var(--dsw-alias-bg-1,#fff);color:inherit;cursor:pointer;font-size:12px;line-height:1.6}',
  '.dsh-toolbox-archive button:hover:not(:disabled){background:var(--dsw-alias-bg-hover,#f3f3f3)}',
  '.dsh-toolbox-archive button:disabled{opacity:.5;cursor:not-allowed}',
  '.dsh-toolbox-archive button.danger{color:#b3261e;border-color:#b3261e}',
  '.dsh-toolbox-archive button.danger:hover:not(:disabled){background:rgba(179,38,30,.08)}',
  '.dsh-toolbox-archive-confirm{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #b3261e;border-radius:8px;background:rgba(179,38,30,.06);flex-wrap:wrap}',
  '.dsh-toolbox-archive-empty,.dsh-toolbox-archive-note{color:var(--dsw-alias-text-secondary,#888);font-size:12px;margin:0}',
  '.dsh-toolbox-archive-note{color:#b3261e}',
].join('\n')

function ArchiveView() {
    const [view, setView] = useState(() => panel.view())
    const [busy, setBusy] = useState(false)
    const sync = () => setView(panel.view())

    useEffect(() => {
      let live = true
      void panel.refresh().then(() => { if (live) sync() })

      // 订阅 DSH 自己的会话列表：左侧「归档 / 取消归档」是官方动作，
      // 不经过我们的按钮，面板不订阅就永远停在旧列表上（要切页面才更新）。
      // 反过来「恢复」是我们自己的按钮，所以一直即时。
      let stopWatch
      try {
        const sessions = createDshAdapter(ctx).get('sessions')
        const list = sessions && sessions.list
        if (list && typeof list.subscribe === 'function') {
          stopWatch = list.subscribe(() => {
            if (!live) return
            void panel.refresh().then(() => { if (live) sync() })
          })
        }
      } catch (error) {
        console.warn('[dsh-toolbox] 订阅会话列表失败（面板将不会自动跟随归档动作）', error)
      }

      // 兜底轮询：归档状态存在宿主的 workspaceRegistry 里，客户端会话列表
      // 不一定会因为「左侧归档」而变化（S6 实测订阅无效）。
      // 每 2 秒重拉一次，但**只有列表真的变了才重渲染**，避免无谓刷新。
      const poll = setInterval(() => {
        if (!live) return
        const before = panel.view().rows.map((row) => row.id).join(',')
        void panel
          .refresh()
          .then(() => {
            if (!live) return
            const after = panel.view().rows.map((row) => row.id).join(',')
            if (before !== after) sync()
          })
          .catch(() => {})
      }, 2000)

      return () => {
        live = false
        clearInterval(poll)
        try {
          if (typeof stopWatch === 'function') stopWatch()
        } catch (error) {
          /* 退订失败不影响卸载 */
        }
      }
    }, [])

    const refreshHostSessions = () => refreshHostSessionsOf(ctx)

    const run = (action) => async () => {
      setBusy(true)
      try {
        await action()
      } finally {
        // 删除/恢复/彻底删除都走这里，所以刷新覆盖全部动作。
        await refreshHostSessions()
        sync()
        setBusy(false)
      }
    }
    const dangerStyle = { color: '#b3261e', borderColor: '#b3261e', fontWeight: '600' }
    const rowTitle = (row, extra) =>
      h('span', { class: 'dsh-toolbox-archive-title' }, [
        h('strong', null, row.label),
        h('div', { class: 'dsh-toolbox-archive-id' }, extra),
      ])

    return h('div', { class: 'dsh-toolbox-archive' }, [
      h('style', null, PANEL_CSS),
      h('header', null, [
        h('strong', null, '历史归档'),
        h('span', { class: 'dsh-toolbox-archive-count' }, view.view === 'trash'
          ? '回收箱 ' + (view.trash?.protectedCount ?? 0) + ' / ' + (view.trash?.maxProtected ?? 200)
          : (view.rows.length === 0 ? '共 0 条' : '共 ' + view.rows.length + ' 条')),
      ]),
      // 二级页签：不新增侧栏入口，只在面板内切换。
      h('div', { class: 'dsh-toolbox-archive-tabs' }, [
        h('button', {
          type: 'button',
          disabled: busy,
          'aria-pressed': view.view === 'archive' ? 'true' : 'false',
          onClick: () => { panel.switchTo('archive'); void panel.refresh().then(sync) },
        }, '归档'),
        h('button', {
          type: 'button',
          disabled: busy,
          'aria-pressed': view.view === 'trash' ? 'true' : 'false',
          onClick: () => { panel.switchTo('trash'); void panel.refreshTrash().then(sync) },
        }, '回收箱'),
      ]),
      view.message ? h('p', { class: 'dsh-toolbox-archive-note' }, view.message) : null,

      view.view === 'archive'
        ? h('div', null, [
            view.pending
              ? h('div', { class: 'dsh-toolbox-archive-confirm' }, [
                  h('span', null, '移入回收箱（可恢复，到期自动彻底删除）'),
                  h('button', { type: 'button', style: dangerStyle, onClick: run(() => panel.confirmRemove()) }, '入回收箱'),
                  h('button', { type: 'button', onClick: () => { panel.cancelRemove(); sync() } }, '取消'),
                ])
              : null,
            view.rows.length === 0 && !view.message
              ? h('p', { class: 'dsh-toolbox-archive-empty' }, '没有归档会话')
              : null,
            h('ul', null, view.rows.map((row) =>
              h('li', { key: row.id }, [
                rowTitle(row, row.id),
                h('button', { type: 'button', disabled: busy || !view.canDelete, onClick: run(() => panel.unarchive(row.id)) }, '恢复'),
                h('button', {
                  type: 'button',
                  class: 'danger',
                  style: dangerStyle,
                  disabled: busy || !view.canDelete,
                  onClick: () => { panel.askRemove(row.id); sync() },
                }, '删除'),
              ]),
            )),
          ])
        : null,

      view.view === 'trash'
        ? h('div', null, [
            view.purgePending
              ? h('div', { class: 'dsh-toolbox-archive-confirm' }, [
                  h('span', null, '物理删除，无法恢复。确定吗？'),
                  h('button', { type: 'button', style: dangerStyle, onClick: run(() => panel.confirmPurge()) }, '彻底删除'),
                  h('button', { type: 'button', onClick: () => { panel.cancelPurge(); sync() } }, '取消'),
                ])
              : null,
            view.trash.rows.length === 0 && !view.message
              ? h('p', { class: 'dsh-toolbox-archive-empty' }, '回收箱是空的')
              : null,
            h('ul', null, view.trash.rows.map((row) =>
              h('li', { key: row.id }, [
                rowTitle(row, phaseLabel(row.phase) + ' · ' + (row.remainingDays === 0 ? '今天到期' : '剩余 ' + row.remainingDays + ' 天')),
                h('button', { type: 'button', disabled: busy, onClick: run(() => panel.restoreTrash(row.id)) }, '恢复'),
                h('button', {
                  type: 'button',
                  class: 'danger',
                  style: dangerStyle,
                  disabled: busy,
                  onClick: () => { panel.askPurge(row.id); sync() },
                }, '彻底删除'),
              ]),
            )),
          ])
        : null,
    ])
  }

  // The sidebar's panellist slot renders the GLYPH inside the host's own
  // <button>; the host handles selectPanel(id). Returning another button here
  // creates a nested <button> (invalid DOM) and steals the host's click.
  function SidebarRow() {
    return h(
      'svg',
      {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
      [
        h('path', { key: 'box', d: 'M2.5 5.5h11M4 5.5V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V5.5M5.5 5.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2.5M6 9h4' }),
      ],
    )
  }

  // The body of the panel, in the same slot the plugin manager uses.
  const mainReg = ctx.slots.register({ name: MAIN_SLOT, key: PANEL_ID }, ArchiveView)
  console.info('[dsh-toolbox] registered main panel, disposer =', typeof mainReg)
  if (typeof mainReg === 'function') env.track(mainReg)
  // The sidebar entry that selects it.
  // A LIST slot wants id; the main slot wants key. They are different registries.
  const rowReg = ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register({ name: PANEL_SLOT, id: PANEL_ID, order: 200, label: '历史归档' }, SidebarRow))
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
      // layout 是可选能力：没有它最多是点侧栏行不切面板，不该崩。
  const layout = createDshAdapter(ctx).get('layout')
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
