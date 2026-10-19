/**
 * 宿主侧官方兼容防腐层（S6-a）。
 *
 * 与客户端 `src/client/dsh-adapter.js` 同构，但管的是宿主服务：
 *
 *   webServer        注册 7 条归档路由（**必需**）
 *   workspaceRegistry 归档集合 / 工作区行 / 快照回插（**必需**）
 *   sessions         判活（可选，缺失时失败关闭）
 *   sessionQuery     session_search 工具（可选，缺失时工具不注册）
 *
 * 为什么宿主比客户端更该有这一层：S4 期间所有底层大坑都在这里——
 * `WebRoute.method` 被移除、`workspaceRegistry` 晚到、`sessions.get` 语义从
 * 「在跑」变成「加载过」。任何一处形状变化都能让整个归档功能挂掉，
 * 而客户端只会看到「接口 404 / 操作失败」，根本猜不到原因。
 *
 * 规则与客户端一致：
 *   1. 每次读都 `typeof` 检查，缺了返回 `undefined`，**绝不抛**；
 *   2. 每个服务只警告一次；
 *   3. `selfCheck()` 每次真实探测，空环境必须报红；
 *   4. 调用方拿到 `undefined` 就降级（关掉那一个子功能）。
 */

/** 服务名 → 必需能力。 */
export const HOST_SERVICE_CHECKS = Object.freeze({
  webServer: (service) => typeof service?.register === 'function',
  workspaceRegistry: (service) =>
    typeof service?.list === 'function' || typeof service?.archivedSessionIds !== 'undefined',
  sessions: (service) => typeof service?.get === 'function',
  sessionQuery: (service) =>
    typeof service?.search === 'function' || typeof service?.searchSessions === 'function',
})

/**
 * 缺了它整个归档功能就没法工作的服务。
 *
 * `webServer` 缺失 → 路由无处挂；`workspaceRegistry` 缺失 → 连归档集合都读不到。
 * 其余两个缺失只影响对应子功能（判活 / 搜索工具）。
 */
export const HOST_REQUIRED_SERVICES = Object.freeze(['webServer', 'workspaceRegistry'])

/**
 * 包一层宿主 ctx。
 *
 * @param {object} ctx - Cordis 宿主 ctx（可以是作用域 ctx）
 * @param {{ label?: string, logger?: object }} [options]
 */
export function createHostAdapter(ctx, options = {}) {
  const label = options.label ?? 'dsh-toolbox'
  const logger = options.logger ?? console
  const warned = new Set()
  const missing = []
  const degraded = []

  const warnOnce = (service, detail) => {
    if (warned.has(service)) return
    warned.add(service)
    try {
      logger.warn('[' + label + '] 宿主服务不可用: ' + service + '（' + detail + '）—— 相关子功能已禁用')
    } catch (error) {
      /* 日志失败不影响主流程 */
    }
  }

  /** 只读探测：不记录、不警告。 */
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
    if (service === undefined) return { state: 'missing' }
    const check = HOST_SERVICE_CHECKS[name]
    if (typeof check === 'function' && !check(service)) return { state: 'degraded' }
    return { state: 'ok', service }
  }

  /** 取服务：缺失/形状不对 → undefined（警告一次）。 */
  const get = (name) => {
    const probed = probe(name)
    if (probed.state === 'missing') {
      if (!missing.includes(name)) missing.push(name)
      warnOnce(name, '不存在')
      return undefined
    }
    if (probed.state === 'degraded') {
      if (!degraded.includes(name)) degraded.push(name)
      warnOnce(name, '形状不匹配，可能是官方改了接口')
      return undefined
    }
    return probed.service
  }

  /** 必需服务：缺失时明确抛错，让插件干净地失败。 */
  const require = (name) => {
    const service = get(name)
    if (service === undefined && HOST_REQUIRED_SERVICES.includes(name)) {
      throw new Error(label + ': 缺少必需的宿主服务 ' + name)
    }
    return service
  }

  /** 结构化自检：每次都真实探测，不依赖之前 get 过什么。 */
  const selfCheck = () => {
    const found = { missing: [], degraded: [], available: [] }
    for (const name of Object.keys(HOST_SERVICE_CHECKS)) {
      const probed = probe(name)
      if (probed.state === 'missing') found.missing.push(name)
      else if (probed.state === 'degraded') found.degraded.push(name)
      else found.available.push(name)
    }
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
