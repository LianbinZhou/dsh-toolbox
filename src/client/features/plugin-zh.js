/**
 * 插件说明汉化（S5 从独立插件 dsh-plugin-zh 迁入，**新增可逆**）。
 *
 * 为什么是「翻译已渲染的文本」而不是原生 locale
 * -----------------------------------------------
 * 插件页的说明来自包元数据。带 `locale/zh.json` 的包显示中文，其余一律英文；
 * 而往 `node_modules` 里补 locale 会被插件更新冲掉。所以这里翻译页面**已经渲染出来**的文本，
 * 插件更新也冲不掉。
 *
 * 和原插件的唯一区别：原插件是**单向**的（改完 nodeValue 就丢了原文），
 * 这里每一处替换都记下原文，`dispose()` 时逐条还原——开关关掉，英文必须回来。
 *
 * 匹配策略（与原插件逐条等价）
 * ----------------------------
 * - 空白归一化后**精确命中**字典键；
 * - 或前 40 字符唯一命中（容忍尾部被截断）；
 * - 短于 18 字符不做前缀匹配，避免误伤普通界面文字。
 */

import { createDshAdapter } from '../dsh-adapter.js'

export const PLUGIN_ZH_DICT = Object.freeze({
  /* --- official core --- */
  'The shared dsh core as a profile bundle: the first patch layer of base-backed profiles, inserting core rows over the empty profile root':
    'DSH 核心本体（地基）：作为 profile 的第一层，把核心组件插到空白的 profile 根上。所有别的插件都装在它上面，不能关。',
  'The dsh browser-surface bundle: the web patch layer over dsh-base plus the runtime glue plugin (frontend dist serving, bash runtime variables, URL line)':
    '网页外壳：在核心之上补齐整个网页界面（前端资源、运行时变量、访问地址）。你现在看到的这个界面就是它，不能关。',

  /* --- vision / memory / market --- */
  'Plug-in vision for text-only LLMs, powered by the free Antigravity CLI':
    '给「只认文字」的模型加眼睛：让 AI 能看图（截图、图表、扫描件）。读你截图靠它，别关。',
  'Composable, view-based memory for DeepSeek Harness. Pluggable sources and strategies, with layered memory out of the box.':
    '分层记忆：可插拔的记忆源与策略，把你的偏好、项目事实、长期知识分开存。每回合提示里那堆记忆就是它。',
  'Visual plugin market inside DeepSeek Harness — browse, search, and one-click install community plugins. · DSH 可视化插件市场：逛一逛，点一下，装好。':
    '可视化插件市场：逛一逛、搜一搜、点一下装好社区插件。',
  'Archive manager for the dsh web GUI: a sidebar entry that lists archived sessions, restores them back to the workspace, and permanently deletes them after confirmation':
    '会话归档面板：列出已归档的会话，能一键恢复到工作区，也能二次确认后永久删除。',

  /* --- the linxin666 family --- */
  'Session archive management for DSH Web: centralized inventory, batch archive/restore, physical delete with family cascade, and optional auto-archive / auto-cleanup policies.':
    '会话归档管理：集中清点、批量归档/恢复、连带删除，还能设「自动归档 / 自动清理」规则。',
  'External dsh web GUI plugin: a blank-session git branch selector + Git graph, with real host-side git operations and guards, as a dsh profile bundle':
    'Git 图谱 + 分支选择器：空白会话里能选 git 分支，真实在宿主侧跑 git 操作，带安全保护。',
  'DSH skill center: browse loaded skills by source (bundled / project / user / custom / runtime), enable or disable, create and delete, in a web GUI panel.':
    '技能中心：按来源（内置 / 项目 / 用户 / 自定义 / 运行时）浏览已加载的技能，能启用停用、新建删除。',
  "Self-update plugin for the dsh web GUI: probes npm for newer family releases and runs the owning profile's pnpm update in place, from a sidebar trigger beside the settings seat with a release-notes panel":
    '自更新：去 npm 查这一族插件有没有新版本，就地跑 pnpm 更新，侧栏有入口，还带更新日志面板。',
  "Usage statistics plugin for the dsh web GUI: per-provider balance and coding-plan quota detection plus a live token usage ledger, with a compact price glance card above the sidebar's Settings row":
    '用量统计：查各服务商的余额和套餐额度，还有一份实时 token 用量账本，压在侧栏「设置」上方。',

  /* --- the plugins this machine actually runs --- */
  'DSH Web UI plugin: automatically sends a localized continue prompt when a request is interrupted by network errors or other non-human causes':
    '自动续跑：会话被网络错误、超时、或「只有思考没正文就结束」打断时，自动替你补一句「继续」，让任务接着跑。带退避和死循环熔断。',

  /* --- official experimental bundles --- */
  'Agent Teams collaboration, tools, and Web UI in one experimental bundle':
    'Agent 团队：多个 AI 分工协作（队长 + 队员、共享任务板、互相发消息），含配套工具和界面。',
  'Per-tool LLM authorization review for the DeepSeek Harness Auto permission preset':
    '自动审查：在「自动」权限档位下，每个工具调用都先让模型复核一遍再放行。',
  'Let agents add a “powered by dsh” badge to documents, pull requests, and other outputs.':
    '给文档、PR 等产出加上「powered by dsh」角标。',
  'Experimental machine translation of expanded reasoning':
    '把展开的推理过程机翻成中文显示。',
  'Run explicitly requested repeated work with fresh agents.':
    'Ralph 循环：按你的明确要求，用「全新的子代理」一轮一轮反复打磨同一个目标。',
  'Optional Web bundle for raw Session logs and Chat node inspection':
    '检视器：直接看会话的原始日志和每一条消息节点，排障时有用。',
  'Refresh session titles as new human prompts arrive.':
    '每来一条新提问就刷新会话标题。',
  'Keep shell processes alive across tool calls.':
    '持久终端：shell 进程跨工具调用存活，长命令不用重开。',
  'Model tool that creates and enters a new Git worktree':
    '让我能新建并进入一个 Git worktree（并行开发不同分支用）。',
  'Experimental voice input with local SenseVoice; downloads its runtime on first use':
    '语音输入：本地 SenseVoice 模型，第一次用时会自动下载运行库。',
  'Give Agents tools to search and read earlier sessions from the current workspace.':
    '给我「搜索/读取历史会话」的工具，能在当前工作区里翻以前的对话。',
  'Experimental custom plugin markets: a Discover tab that browses and installs bundles from plugin market indexes':
    '自定义插件市场源：多一个「发现」页，从别的插件市场索引里浏览和安装。',

  /* --- other profile bundles --- */
  'The dsh ACP profile bundle: automation-only JSON-RPC stdio and process lifecycle over dsh-base':
    'ACP 档：只做自动化的 JSON-RPC stdio 接口和进程生命周期管理，没有界面。',
  'The dsh one-shot bundle: a direct core Agent/Session runner over dsh-base with no Host, HTTP, or browser layer':
    '一次性执行档：直接跑核心 Agent / 会话，没有界面、没有 HTTP、没有浏览器层。',
  'The dsh SDK profile bundle: stdio JSON-RPC serving and process lifecycle over dsh-base':
    'SDK 档：通过 stdio 提供 JSON-RPC 服务，给别的程序调用 DSH 用。',
  'The standalone minimal SDK profile bundle: JSON-RPC, one DeepSeek adapter, persistent shell, and JSONL sessions':
    '极简 SDK 档：JSON-RPC + 一个 DeepSeek 适配器 + 持久 shell + JSONL 会话，最小可跑组合。',
})

export const PREFIX_LEN = 40
export const MIN_LEN = 18

/** 折叠所有空白，让渲染后的文本能与源字符串对上。 */
export function normalize(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

/** 由字典构建查找表（精确 + 前 40 字符唯一）。 */
export function buildLookup(dict) {
  const table = new Map()
  const prefix = new Map()
  const collisions = new Set()
  for (const [en, zh] of Object.entries(dict)) {
    const key = normalize(en)
    table.set(key, zh)
    if (key.length >= PREFIX_LEN) {
      const head = key.slice(0, PREFIX_LEN)
      if (prefix.has(head) && prefix.get(head) !== zh) collisions.add(head)
      else prefix.set(head, zh)
    }
  }
  for (const head of collisions) prefix.delete(head)
  return (text) => {
    const key = normalize(text)
    if (key.length < MIN_LEN) return undefined
    const exact = table.get(key)
    if (exact !== undefined) return exact
    if (key.length < PREFIX_LEN) return undefined
    return prefix.get(key.slice(0, PREFIX_LEN))
  }
}

export const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION'])

/** 只记录长且可打印 ASCII 的英文串，中文永远不会被记成 unknown。 */
export function looksEnglish(text) {
  return text.length >= 40 && /^[\x20-\x7E\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00B7]+$/.test(text)
}

/**
 * 翻译一个文本节点，并把原文记进 `applied`。
 *
 * 幂等：`applied` 是 Map<node, {original, translated}>。
 * 同一个节点再次进来时，若内容仍等于我们写进去的 `translated` 就跳过；
 * 若被 React 改回英文，则把当前值当新原文重新查（否则开关明明开着却显示英文）。
 *
 * @returns {boolean} 是否命中字典
 */
export function translateTextNode(node, lookup, applied) {
  const parent = node.parentElement
  if (!parent || SKIP_TAGS.has(parent.tagName)) return false
  const raw = node.nodeValue
  if (!raw) return false

  const previous = applied.get(node)
  if (previous) {
    // 还是我们写进去的中文 → 不用重翻。
    if (node.nodeValue === previous.translated) return true
    // React 把同一个节点改回了别的文本：把当前值当新原文，重新查。
    applied.delete(node)
  }

  const zh = lookup(raw)
  if (zh === undefined) return false
  if (raw !== zh) {
    node.nodeValue = zh
    applied.set(node, { original: raw, translated: zh })
  }
  return true
}

/**
 * 清掉已经脱离 DOM 的记录。
 *
 * 必须做：React 每次重渲染都会替换文本节点，旧节点留在 Map 里就是内存泄漏。
 */
export function pruneApplied(applied) {
  if (!applied || typeof applied.keys !== 'function') return 0
  let removed = 0
  for (const node of applied.keys()) {
    if (!node || node.isConnected === false) {
      applied.delete(node)
      removed += 1
    }
  }
  return removed
}

/** 逐条还原英文原文。还原失败（节点已脱离 DOM）只跳过，不抛。 */
export function restoreApplied(applied) {
  let restored = 0
  if (!applied || typeof applied.keys !== 'function') return restored
  for (const node of [...applied.keys()]) {
    const record = applied.get(node)
    applied.delete(node)
    if (!node || !record) continue
    // 节点已脱离 DOM：只清记录，别写。
    if (node.isConnected === false) continue
    // 内容已经被改过（React 复用节点）：绝不覆盖新文本，只清记录。
    if (node.nodeValue !== record.translated) continue
    try {
      node.nodeValue = record.original
      restored += 1
    } catch (error) {
      /* 节点没了就不管 */
    }
  }
  return restored
}

/**
 * 挂载翻译器。
 *
 * @param {object} options
 * @param {'zh'|'en'|string} options.locale - 界面语言；非中文不工作
 * @param {object} [options.doc] - 测试注入的 document
 * @param {object} [options.win] - 测试注入的 window
 * @returns {{ dispose: () => number, state: object, lookup: Function, toast: Function }}
 */
export function mountPluginZh({ locale = 'zh', doc, win } = {}) {
  const documentRef = doc ?? (typeof document !== 'undefined' ? document : undefined)
  const windowRef = win ?? (typeof window !== 'undefined' ? window : undefined)
  const lookup = buildLookup(PLUGIN_ZH_DICT)
  // WeakMap 语义：节点不被这里强引用；每轮 pass 后 prune 掉已脱离 DOM 的。
  const applied = new Map()
  const state = { unknown: new Set(), replaced: 0, passes: 0, lastPass: 0 }
  const enabled = String(locale).toLowerCase().startsWith('zh')

  let observer = null
  let scheduled = false
  let disposed = false
  let toastShown = false

  const requestIdle =
    windowRef && typeof windowRef.requestIdleCallback === 'function'
      ? windowRef.requestIdleCallback.bind(windowRef)
      : (fn) => setTimeout(fn, 0)

  const insidePluginList = (element) => {
    let node = element
    while (node && node !== documentRef.body) {
      if (node.hasAttribute && (node.hasAttribute('data-plugin-rows') || node.hasAttribute('data-plugin-inventory'))) return true
      node = node.parentElement
    }
    return false
  }

  const pass = (root) => {
    if (!root || !documentRef || !documentRef.body || disposed) return 0
    state.lastPass = 0
    state.passes += 1
    if (root.nodeType === 3) {
      if (translateTextNode(root, lookup, applied)) state.lastPass += 1
      pruneApplied(applied)
      state.replaced += state.lastPass
      return state.lastPass
    }
    const walker = documentRef.createTreeWalker(root, 4, {
      acceptNode(candidate) {
        const parent = candidate.parentElement
        if (!parent || SKIP_TAGS.has(parent.tagName)) return 2 // FILTER_REJECT
        return 1 // FILTER_ACCEPT
      },
    })
    const nodes = []
    let current
    while ((current = walker.nextNode())) nodes.push(current)
    for (const node of nodes) {
      if (translateTextNode(node, lookup, applied)) state.lastPass += 1
      else {
        const key = normalize(node.nodeValue ?? '')
        if (looksEnglish(key) && node.parentElement && insidePluginList(node.parentElement)) state.unknown.add(key)
      }
    }
    state.replaced += state.lastPass
    pruneApplied(applied)
    return state.lastPass
  }

  const toast = (count) => {
    if (toastShown || count <= 0 || !documentRef || !documentRef.body) return
    toastShown = true
    try {
      const box = documentRef.createElement('div')
      box.id = 'dsh-toolbox-zh-toast'
      box.textContent = '插件说明已汉化：本页替换 ' + count + ' 处'
      box.style.cssText = [
        'position:fixed',
        'right:16px',
        'bottom:16px',
        'z-index:2147483000',
        'padding:8px 14px',
        'border-radius:8px',
        'background:rgba(20,20,22,.92)',
        'color:#fff',
        'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif',
        'box-shadow:0 6px 20px rgba(0,0,0,.28)',
        'pointer-events:none',
        'opacity:1',
        'transition:opacity .6s ease',
      ].join(';')
      documentRef.body.appendChild(box)
      setTimeout(() => {
        box.style.opacity = '0'
      }, 4200)
      setTimeout(() => {
        box.remove()
      }, 5000)
    } catch (error) {
      /* 自证条失败不影响翻译 */
    }
  }

  const runNow = () => {
    if (disposed) return 0
    const changed = pass(documentRef.body)
    if (changed > 0) {
      toast(state.replaced)
      console.info('[dsh-toolbox] 插件汉化：本次替换 ' + changed + ' 处，累计 ' + state.replaced)
    }
    return changed
  }

  const schedule = () => {
    if (scheduled || disposed) return
    scheduled = true
    requestIdle(() => {
      scheduled = false
      runNow()
    }, { timeout: 500 })
  }

  const begin = () => {
    if (disposed) return
    if (!documentRef || !documentRef.body) return
    runNow()
    if (enabled && typeof MutationObserver === 'function') {
      observer = new MutationObserver(schedule)
      observer.observe(documentRef.body, { childList: true, subtree: true, characterData: true })
    }
  }

  if (documentRef && documentRef.body) begin()
  else if (documentRef && typeof documentRef.addEventListener === 'function') {
    documentRef.addEventListener('DOMContentLoaded', begin, { once: true })
  }

  console.info('[dsh-toolbox] 插件汉化启动，locale=' + locale + '，词条=' + Object.keys(PLUGIN_ZH_DICT).length)

  return {
    state,
    lookup,
    toast,
    /** 断开 observer 并把所有替换还原成英文。 */
    dispose() {
      disposed = true
      if (observer) {
        try {
          observer.disconnect()
        } catch (error) {
          /* ignore */
        }
        observer = null
      }
      try {
        const box = documentRef && documentRef.getElementById ? documentRef.getElementById('dsh-toolbox-zh-toast') : null
        if (box) box.remove()
      } catch (error) {
        /* ignore */
      }
      return restoreApplied(applied)
    },
  }
}


/**
 * 容器用的挂载入口。
 *
 * 语言判断、adapter 取服务、mount、dispose 全部在这里；
 * `features.js` 只留一行配置（Pi 要求：注册表里不许有功能逻辑）。
 */
export function mountFeature(ctx, env) {
  const dsh = createDshAdapter(ctx)
  const localeService = dsh.get('locale')

  let locale = 'zh'
  try {
    const snapshot = localeService && typeof localeService.getSnapshot === 'function' ? localeService.getSnapshot() : undefined
    const active = snapshot && (snapshot.active || snapshot.locale)
    if (active !== undefined) locale = String(active).toLowerCase()
  } catch (error) {
    /* 读不到语言就按中文处理 */
  }

  const handle = mountPluginZh({ locale })
  env.track(() => handle.dispose())
  return () => handle.dispose()
}
