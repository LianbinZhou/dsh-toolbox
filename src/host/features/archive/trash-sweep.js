/**
 * 垃圾箱到期清理。
 *
 * 删除只把目录移进垃圾箱并记一条 cleaned；真正的物理清空集中在这里，
 * 只处理「超过保留期」的记录。保留期默认 7 天，可在依赖里改。
 *
 * 清空之前再核对一次：目录必须仍在该垃圾箱根内，绝不顺着链接删到别处。
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DAY = 24 * 60 * 60 * 1000

/**
 * 扫描并清空过期记录。
 * @param {object} options
 * @param {object} options.journal 删除日志
 * @param {object} options.service 归档服务（用到 purge）
 * @param {number} [options.ttlDays] 保留天数
 * @param {number} [options.now] 当前时间
 * @returns {Promise<{scanned:number, purged:number, failed:number}>}
 */
export async function sweepExpiredTrash({ journal, service, ttlDays = 7, now = Date.now() } = {}) {
  const result = { scanned: 0, purged: 0, failed: 0 }
  if (!journal || typeof journal.read !== 'function' || !service || typeof service.purge !== 'function') return result

  // 先把「删到一半」的记录收尾，再谈清理；否则 trashed 是待办，不是垃圾。
  if (typeof service.heal === 'function') {
    try {
      await service.heal()
    } catch (error) {
      /* heal 失败不阻塞清理，但不会把 trashed 当垃圾 */
    }
  }

  let entries = []
  try {
    entries = journal.read()
  } catch (error) {
    return result
  }

  const cutoff = now - ttlDays * DAY
  for (const entry of entries) {
    if (!entry || (entry.phase !== 'cleaned' && entry.phase !== 'trashed')) continue
    const at = typeof entry.at === 'number' ? entry.at : NaN
    if (!Number.isFinite(at) || at > cutoff) continue
    result.scanned += 1
    try {
      const outcome = await service.purge(entry.id)
      if (outcome && outcome.ok && outcome.purged !== false) result.purged += 1
      else result.failed += 1
    } catch (error) {
      result.failed += 1
    }
  }
  return result
}

/** 垃圾箱里现有的条目（诊断与面板用）。 */
export function listTrashEntries(trashRoot) {
  const out = []
  let names = []
  try {
    names = readdirSync(trashRoot)
  } catch (error) {
    return out
  }
  for (const name of names) {
    const full = join(trashRoot, name)
    try {
      const stat = statSync(full)
      out.push({ name, path: full, at: stat.mtimeMs })
    } catch (error) {
      /* 忽略单项失败 */
    }
  }
  return out
}
