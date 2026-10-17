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
export const REASON_TEXT = Object.freeze({
  'refresh-required': '需要刷新页面（凭证已失效）',
  'token-unavailable': '拿不到凭证：请确认第 7 个开关已开启，然后刷新页面',
  'network-error': '网络错误：宿主可能正在重启',
  disposed: '面板已卸载，请刷新页面',
  'archive-session-adapter-unavailable': '宿主还没接上会话服务，归档接口暂不可用',
  live: '这个会话正在使用中，不能删除',
  'not-archived': '这个会话已经不在归档列表里了',
  'trash-full': '回收站已满：请先恢复或清理，再删除',
  'journal-corrupt': '回收站状态文件损坏，已停止删除（请人工检查）',
  'cross-device': '回收站和会话不在同一个磁盘，无法原子移动',
  'unsafe-trash-root': '回收站位置不安全，已拒绝执行',
  'claim-failed': '删除声明写入失败',
  'http-404': '接口没有注册：请打开第 7 个开关',
  'http-503': '服务未就绪',
})

/**
 * @param {object} options
 * @param {object} options.client - createArchiveClient(...)
 * @param {() => boolean} options.isEnabled - the live 7th switch
 */
export function createArchivePanel({ client, isEnabled }) {
  let rows = []
  let titles = {}
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
    return REASON_TEXT[reason] ?? '操作失败：' + String(reason ?? 'unknown')
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
