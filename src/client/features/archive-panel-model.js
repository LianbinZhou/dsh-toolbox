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

  async function act(kind, id) {
    if (!enabled()) return { ok: false, reason: 'disabled' }
    const result = kind === 'delete' ? await client.delete(id) : await client.unarchive(id)
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
      return act('delete', id)
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
            label: titles[row.id] || '会话 ' + String(row.id).slice(-8),
          }),
        ),
        canDelete: enabled(),
        pending,
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
