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

/** 缺了它整个插件就没法工作的服务。 */
export const REQUIRED_SERVICES = Object.freeze(['slots'])

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
  const warned = new Set()
  const missing = []
  const degraded = []

  const warnOnce = (service, detail) => {
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
  const selfCheck = () => ({
    label,
    ok: missing.length === 0 && degraded.length === 0,
    missing: [...missing],
    degraded: [...degraded],
    available: Object.keys(SERVICE_CHECKS).filter((name) => missing.indexOf(name) < 0 && degraded.indexOf(name) < 0),
  })

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
