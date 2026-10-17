/**
 * The single source of truth for the switches.
 *
 * Seven switches, in display order. Five drive a client feature; `sessionSearch`
 * and `archiveHttpApi` drive the HOST only (the `session_search` tool, and the
 * experimental HTTP delete route), so the client feature list is five while the
 * settings card shows seven — that is not a typo.
 */

export const SWITCHES = Object.freeze([
  { key: 'quoteReply', label: '划词引用', hint: '划选对话文字后浮出「引用 / 复制」' },
  { key: 'draftSaver', label: '草稿保险箱', hint: '没发送的内容不会丢' },
  { key: 'panelMenu', label: '面板收纳', hint: '把侧栏的面板入口收进一个菜单' },
  { key: 'archivePanel', label: '历史归档', hint: '列归档会话、一键恢复、删除' },
  { key: 'pluginZh', label: '插件说明汉化', hint: '插件管理页的英文简介换成中文' },
  { key: 'sessionSearch', label: '会话搜索（宿主工具）', hint: '给 AI 一个 session_search 工具；不影响侧栏搜索' },
  { key: 'archiveHttpApi', label: '归档 HTTP 接口（实验性）', hint: '给页面一个带令牌的删除通道；默认关闭', hostOnly: true },
])

export const SWITCH_KEYS = Object.freeze(SWITCHES.map((entry) => entry.key))

/** Client-side features; `sessionSearch` is host-only. */
export const CLIENT_SWITCH_KEYS = Object.freeze(
  SWITCHES.filter((entry) => entry.hostOnly !== true && entry.key !== 'sessionSearch').map((entry) => entry.key),
)
