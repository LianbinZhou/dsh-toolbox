/**
 * 原因码的**唯一来源**。
 *
 * 以前三处各有一套：服务层返回 `session-is-live`、传输层白名单写的是 `live`、
 * 前端文案又按 `live` 查表。结果测试用假码能过，真实用户看到的却是
 * `request-failed`——测的不是生效的那条路。
 *
 * 现在只有这一张表：
 *   internal  服务层实际返回的码（service.js 的 REASONS）
 *   wire      允许出网的码，前端按它查文案
 *   text      给用户看的中文
 *
 * 加新码只有一个动作：往这张表加一行。
 */

export const REASON_MAP = Object.freeze({
  // —— 参数与状态 ——
  'invalid-id': { wire: 'invalid-id', text: '会话 id 不合法' },
  'not-archived': { wire: 'not-archived', text: '这个会话已经不在归档列表里了' },
  'no-longer-archived': { wire: 'not-archived', text: '已经不在归档列表' },
  'dir-absent': { wire: 'dir-absent', text: '会话目录已经不在了' },
  'already-deleted': { wire: 'already-deleted', text: '这个会话已经删过了' },
  'delete-in-progress': { wire: 'in-progress', text: '这个会话正在删除中' },

  // —— 存活与身份 ——
  'session-is-live': { wire: 'live', text: '这个会话正在使用中，不能删除' },
  'session-became-live': { wire: 'live', text: '会话刚被打开，已取消删除' },
  'identity-changed': { wire: 'identity-changed', text: '会话目录已变化，已拒绝' },

  // —— 路径与磁盘 ——
  'unsafe-path': { wire: 'unsafe-path', text: '路径不安全，已拒绝' },
  'unsafe-trash-root': { wire: 'unsafe-path', text: '回收站位置不安全，已拒绝执行' },
  'cross-volume-trash': { wire: 'cross-device', text: '回收箱和会话不在同一个磁盘，无法原子移动' },

  // —— 执行失败 ——
  'probe-failed': { wire: 'probe-failed', text: '检查会话目录时出错' },
  'claim-failed': { wire: 'claim-failed', text: '删除声明写入失败' },
  'move-failed': { wire: 'remove-failed', text: '移入回收箱失败' },
  'restore-failed': { wire: 'restore-failed', text: '恢复失败' },
  'purge-failed': { wire: 'purge-failed', text: '彻底删除失败' },

  // —— 回收箱 ——
  'cleanup-only': { wire: 'cleanup-only', text: '目录已不在，只做了清理' },
  'cleanup-pending': { wire: 'cleanup-pending', text: '已移入回收箱，但归档标记清理未完成' },
  'journal-corrupt': { wire: 'journal-corrupt', text: '回收站状态文件损坏，已停止删除（请人工检查）' },
  'trash-full': { wire: 'trash-full', text: '回收箱已满（上限 200）：请先恢复或彻底删除，再继续' },
  'no-entry': { wire: 'no-entry', text: '没有这条记录' },
  'not-in-trash': { wire: 'not-in-trash', text: '这条不在回收箱里' },
  'confirm-required': { wire: 'confirm-required', text: '彻底删除需要二次确认' },

  // —— 兜底 ——
  'request-failed': { wire: 'request-failed', text: '操作失败' },
})

/** 允许出网的码集合（由表生成，不手写第二份）。 */
export const WIRE_REASONS = Object.freeze(new Set(Object.values(REASON_MAP).map((entry) => entry.wire)))

/**
 * 内部码 → 出网码。未知码收敛成 request-failed，绝不原样出网。
 * @param {unknown} reason
 * @returns {string}
 */
export function toWireReason(reason) {
  if (typeof reason !== 'string') return 'request-failed'
  const entry = REASON_MAP[reason]
  if (entry) return entry.wire
  // 已经是合法出网码时原样返回（幂等）
  if (WIRE_REASONS.has(reason)) return reason
  return 'request-failed'
}

/**
 * 给用户看的中文。内部码和出网码都能查。
 * @param {unknown} reason
 * @returns {string}
 */
export function reasonText(reason) {
  if (typeof reason === 'string') {
    const entry = REASON_MAP[reason]
    if (entry) return entry.text
    for (const candidate of Object.values(REASON_MAP)) {
      if (candidate.wire === reason) return candidate.text
    }
  }
  return REASON_MAP['request-failed'].text
}

/** 服务层可能返回的全部内部码，测试用它遍历。 */
export const INTERNAL_REASONS = Object.freeze(Object.keys(REASON_MAP))
