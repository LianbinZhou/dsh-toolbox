/**
 * S4-c · the archive panel (client).
 *
 * The old panel hacked the DOM: it inserted its own <style>, watched the document
 * with two MutationObservers, polled with setInterval, and owned a React root.
 * None of that exists here. This module is a STATE MACHINE returning a tree; the
 * container decides where to draw it.
 *
 * Every request goes through one `createArchiveClient` instance, so the token
 * lives in exactly one closure and a 401 refreshes once for all callers.
 *
 * Three states the old panel never had, and the messages users actually need:
 *
 *   disabled  the 7th switch is off => NO request is made at all
 *   refused   401 after the single retry => "reload the page"
 *   missing   404 => the routes are not mounted => "turn the switch on"
 *   unavailable 503 => the host has no session adapter => not a user error
 *   live / trash-full / journal-corrupt => the service's own reason, phrased
 */

/** The user-facing text for each refusal reason. One place, no scattered strings. */
/** 只有客户端自己会产生的码；服务层的原因码一律走共享表。 */
import { reasonText as sharedReasonText } from '../../shared/reasons.js'

const CLIENT_REASON_TEXT = Object.freeze({
  'refresh-required': '需要刷新页面（凭证已失效）',
  'token-unavailable': '拿不到凭证：请确认第 7 个开关已开启，然后刷新页面',
  'network-error': '网络错误：宿主可能正在重启',
  disposed: '面板已卸载，请刷新页面',
  'archive-session-adapter-unavailable': '宿主还没接上会话服务，归档接口暂不可用',
  'http-401': '宿主还是旧代码（回收箱接口未加载）：请重启 DSH，然后刷新页面',
  'http-404': '接口没有注册：请打开第 7 个开关',
  'http-503': '服务未就绪',
})

/** 兼容旧引用的合并表（客户端码优先，其余来自共享表）。 */
export const REASON_TEXT = Object.freeze({
  ...Object.fromEntries(Object.entries(CLIENT_REASON_TEXT)),
})

/** 唯一入口：先认客户端码，再交给共享表。 */
export function reasonTextFor(reason) {
  if (typeof reason === 'string' && CLIENT_REASON_TEXT[reason]) return CLIENT_REASON_TEXT[reason]
  return sharedReasonText(reason)
}

/**
 * @param {object} options
 * @param {object} options.client - createArchiveClient(...)
 * @param {() => boolean} options.isEnabled - the live 7th switch
 */
export function createArchivePanel({ client, isEnabled }) {
  let rows = []
  let titles = {}
  /** 待确认删除的会话；点「删除」先落到这里，再点「入回收箱」才真执行。 */
  let pending = null
  /** 当前页签：归档 / 回收箱。不新增侧栏入口，只在面板内切换。 */
  let viewMode = 'archive'
  let trashRows = []
  let trashMeta = {}
  let purgePending = null
  let state = 'idle' // idle | disabled | loading | ready | error
  let message = ''

  const enabled = () => {
    try {
      return isEnabled() === true
    } catch (error) {
      return false
    }
  }

  function phrase(reason) {
    return reasonTextFor(reason)
  }

  /** Load the list. Makes no request when the switch is off. */
  async function refresh() {
    if (!enabled()) {
      state = 'disabled'
      message = '归档 HTTP 接口未启用'
      rows = []
      return { ok: false, reason: 'disabled' }
    }
    state = 'loading'
    const result = await client.list()
    if (result.ok) {
      rows = result.rows
      titles = typeof client.titleMap === 'function' ? await client.titleMap() : {}
      state = 'ready'
      message = ''
      return { ok: true }
    }
    state = 'error'
    message = phrase(result.reason)
    return { ok: false, reason: result.reason }
  }

  async function act(kind, id, title) {
    if (!enabled()) return { ok: false, reason: 'disabled' }
    const result = kind === 'delete' ? await client.delete(id, title) : await client.unarchive(id)
    if (!result.ok) {
      message = phrase(result.reason)
      return result
    }
    message = ''
    await refresh()
    return result
  }

  return {
    refresh,
    /** 切换页签。回收箱不新增入口，只在这里切。 */
    switchTo(mode) {
      viewMode = mode === 'trash' ? 'trash' : 'archive'
      purgePending = null
      message = ''
      return viewMode
    },

    /** 加载回收箱列表。开关关闭时不发请求。 */
    async refreshTrash() {
      if (!enabled()) {
        viewMode = 'trash'
        state = 'disabled'
        message = '归档 HTTP 接口未启用'
        trashRows = []
        return { ok: false, reason: 'disabled' }
      }
      viewMode = 'trash'
      const result = await client.trash()
      if (result.ok) {
        trashRows = result.rows
        // 回收箱的标题也要能显示会话名，否则只剩 id 尾段。
        titles = typeof client.titleMap === 'function' ? await client.titleMap() : titles
        trashMeta = { protectedCount: result.protectedCount, maxProtected: result.maxProtected, keptDays: result.keptDays }
        state = 'ready'
        message = ''
        return { ok: true }
      }
      state = 'error'
      message = phrase(result.reason)
      return { ok: false, reason: result.reason }
    },

    /** 从回收箱恢复。 */
    async restoreTrash(id) {
      if (!enabled()) return { ok: false, reason: 'disabled' }
      const result = await client.restoreFromTrash(id)
      if (!result.ok) {
        message = phrase(result.reason)
        return result
      }
      // 先刷新（它会把 message 清空），再把警告写回去，否则用户看不到。
      await this.refreshTrash()
      message = result.warning === 'cleanup-pending' ? phrase('cleanup-pending') : ''
      return result
    },

    /** 彻底删除：先问，再执行。 */
    askPurge(id) {
      purgePending = id
      message = ''
    },
    cancelPurge() {
      purgePending = null
    },
    async confirmPurge() {
      const id = purgePending
      purgePending = null
      if (id === null) return { ok: false, reason: 'nothing-to-purge' }
      const result = await client.purge(id)
      if (!result.ok) {
        message = phrase(result.reason)
        return result
      }
      message = ''
      await this.refreshTrash()
      return result
    },

    /** 点「删除」：只提问，不动数据。 */
    askRemove(id) {
      pending = id
      message = ''
    },
    /** 确认移入回收箱。 */
    async confirmRemove() {
      const id = pending
      pending = null
      if (id === null) return { ok: false, reason: 'nothing-to-remove' }
      return act('delete', id, titles[id])
    },
    cancelRemove() {
      pending = null
    },
    unarchive: (id) => act('unarchive', id),
    remove: (id) => act('delete', id),
    /** What the container draws. Pure data: no DOM, no observers, no timers. */
    view() {
      return Object.freeze({
        state,
        message,
        rows: rows.map((row) =>
          Object.freeze({
            id: row.id,
            phase: row.phase,
            title: titles[row.id] || '',
            // A title is what a human recognises; the id tail is only a fallback.
            label: titles[row.id] || row.title || '会话 ' + String(row.id).slice(-8),
          }),
        ),
        canDelete: enabled(),
        pending,
        view: viewMode,
        trash: viewMode === 'trash'
          ? {
              rows: trashRows.map((row) => ({
                id: row.id,
                // 标题优先：inventory 里的 → journal 里记下的 → id 尾段兜底。
            label: titles[row.id] || row.title || '会话 ' + String(row.id).slice(-8),
                phase: row.phase,
                at: row.at,
                keptDays: row.keptDays,
                // 剩余天数按到期时间算：keptDays 是总期，不是剩余。
                remainingDays: typeof row.expiresAt === 'number' && row.expiresAt > 0
                  ? Math.max(0, Math.ceil((row.expiresAt - Date.now()) / 86400000))
                  : row.keptDays,
              })),
              protectedCount: trashMeta.protectedCount,
              maxProtected: trashMeta.maxProtected,
              keptDays: trashMeta.keptDays,
            }
          : null,
        purgePending,
      })
    },
    dispose() {
      client.dispose()
      rows = []
      state = 'idle'
      message = ''
    },
  }
}
