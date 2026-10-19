/**
 * 官方兼容防腐层（S5 架构加固）。
 *
 * 为什么需要它
 * ------------
 * 工具箱依赖一批 DSH 官方客户端服务：`slots`、`sessions`、`configForms`、`layout`、`locale`。
 * 官方一升级，这些名字/形状就可能变（S4 期间已经踩过：`WebRoute.method` 被移除、
 * `sessions.get` 的语义从「在跑」变成「加载过」）。
 *
 * 以前这些调用散在 7 个文件里，任何一处形状变化都可能**整个插件白屏**。
 * 现在所有官方访问都走这里：
 *
 *   1. 每次读都做 `typeof` 检查，缺了就返回 `undefined`，**绝不抛**；
 *   2. 每个服务只警告一次，避免控制台刷屏；
 *   3. `selfCheck()` 输出结构化诊断，挂到 `window.__DSH_TOOLBOX__`；
 *   4. 调用方拿到 `undefined` 就降级（关掉那一个子功能），而不是让容器崩掉。
 */

/** 服务名 → 需要检查的能力。`slots` 是必需品，其余可降级。 */
export const SERVICE_CHECKS = Object.freeze({
  slots: (service) => typeof service?.register === 'function' && typeof service?.inject === 'function',
  sessions: (service) => typeof service?.refresh === 'function' || typeof service?.list === 'object',
  configForms: (service) => typeof service?.get === 'function',
  layout: (service) => typeof service?.selectPanel === 'function',
  locale: (service) => typeof service?.register === 'function',
})

/**
 * 缺了它整个插件就没法工作的服务（在 web profile 里这三者必然存在）。
 * 选「必需」而不是「可选等待」，是因为把它们放进可选路径只会让
 * 删除/恢复悄悄降级成「侧栏需要手动刷新」，反而更难发现。
 * `configForms` / `layout` 才是真可选：缺了只影响对应功能。
 */
export const REQUIRED_SERVICES = Object.freeze(['slots', 'locale', 'sessions'])

/**
 * 包一层官方的 ctx。
 *
 * @param {object} ctx - Cordis 客户端 ctx
 * @param {{ label?: string, logger?: object }} [options]
 * @returns {{ get: Function, require: Function, selfCheck: Function, missing: string[] }}
 */
export function createDshAdapter(ctx, options = {}) {
  const label = options.label ?? 'dsh-toolbox'
  const logger = options.logger ?? console
  // quiet：只探测不刷日志。给「高频轮询的可选服务」用（例如设置卡片的重试）。
  const quiet = options.quiet === true
  const warned = new Set()
  const missing = []
  const degraded = []

  const warnOnce = (service, detail) => {
    if (quiet) return
    if (warned.has(service)) return
    warned.add(service)
    try {
      logger.warn('[' + label + '] 官方服务不可用: ' + service + '（' + detail + '）—— 相关子功能已禁用，插件继续运行')
    } catch (error) {
      /* 日志失败不影响主流程 */
    }
  }

  /**
   * 取一个官方服务。
   *
   * 顺序：`ctx[name]` → `ctx.get(name)`。两条路都要 try：
   * 未在 `inject` 里声明的服务，读属性本身就会抛。
   *
   * @param {string} name
   * @returns {object|undefined}
   */
  /** 只读探测：不记录、不警告，供 selfCheck 使用。 */
  const probe = (name) => {
    let service
    try {
      service = ctx ? ctx[name] : undefined
    } catch (error) {
      service = undefined
    }
    if (service === undefined && ctx && typeof ctx.get === 'function') {
      try {
        service = ctx.get(name)
      } catch (error) {
        service = undefined
      }
    }
    const check = SERVICE_CHECKS[name]
    if (service === undefined) return { state: 'missing' }
    if (typeof check === 'function' && !check(service)) return { state: 'degraded' }
    return { state: 'ok', service }
  }

  const get = (name) => {
    const check = SERVICE_CHECKS[name]
    let service

    try {
      service = ctx ? ctx[name] : undefined
    } catch (error) {
      service = undefined
    }

    if (service === undefined && ctx && typeof ctx.get === 'function') {
      try {
        service = ctx.get(name)
      } catch (error) {
        service = undefined
      }
    }

    if (service === undefined) {
      if (!missing.includes(name)) missing.push(name)
      warnOnce(name, '不存在')
      return undefined
    }

    if (typeof check === 'function' && !check(service)) {
      if (!degraded.includes(name)) degraded.push(name)
      warnOnce(name, '形状不匹配，可能是官方改了接口')
      return undefined
    }

    return service
  }

  /** 必需服务：缺失时抛，让容器明确失败而不是半死不活。 */
  const require = (name) => {
    const service = get(name)
    if (service === undefined && REQUIRED_SERVICES.includes(name)) {
      throw new Error(label + ': 缺少必需的官方服务 ' + name)
    }
    return service
  }

  /** 结构化自检，供诊断入口与真机排障使用。 */
  /**
   * 结构化自检。
   *
   * **每次都真实探测所有服务**，不依赖「之前有没有 get 过」——
   * 否则一个服务都没有的环境也会返回 ok:true，真机排障第一步就被骗。
   */
  const selfCheck = () => {
    const found = { missing: [], degraded: [], available: [] }
    for (const name of Object.keys(SERVICE_CHECKS)) {
      const probed = probe(name)
      if (probed.state === 'missing') found.missing.push(name)
      else if (probed.state === 'degraded') found.degraded.push(name)
      else found.available.push(name)
    }
    // 让 get() 之后的警告/记录与真实状态同步（只有探测过的才进列表）。
    for (const name of found.missing) if (!missing.includes(name)) missing.push(name)
    for (const name of found.degraded) if (!degraded.includes(name)) degraded.push(name)
    return {
      label,
      ok: found.missing.length === 0 && found.degraded.length === 0,
      missing: found.missing,
      degraded: found.degraded,
      available: found.available,
    }
  }

  return { get, require, selfCheck, missing, degraded }
}

/**
 * 包一层「可能没有」的官方方法调用：只做存在性检查，缺了就返回 undefined。
 * 用于 `sessions.refresh()` 这类可能被官方改名的方法。
 */
export async function callOptional(target, method, ...args) {
  if (!target || typeof target[method] !== 'function') return undefined
  try {
    return await target[method](...args)
  } catch (error) {
    return undefined
  }
}
