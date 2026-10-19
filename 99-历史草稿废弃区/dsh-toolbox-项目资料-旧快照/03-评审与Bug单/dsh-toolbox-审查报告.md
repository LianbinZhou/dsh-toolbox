# dsh-toolbox 技术方案 · 审查报告

> **审查对象**：`DeepSeek_Harness_Projects/dsh-toolbox-技术方案.md`（方案 v1）
> **审查角色**：审查官（只读；未改动任何被审代码）
> **审查日期**：2026-10-17
> **对照环境**：本机安装的 `@deepseek-ai/dsh@0.2.1-alpha.4` 源码
> （`C:\Users\zhou0\.npm-global\node_modules\@deepseek-ai\dsh\`）
> **对照代码**：`DeepSeek_Harness_Projects/dsh-plugins/` 下 6 个插件的当前工作副本
>
> **证据纪律**：下面的“已确认”都指“我在上述快照里读到的源码/实际命令输出”；
> 你的 DSH 若已升级、或 profile 状态与我看到的不同，结论需要重验。
> DSH 目前是 alpha 版本，内部实现随时可能变；本报告的所有“官方行为”都以这个版本为准。

---

## 0. 一句话结论

**不能按 v1 原样批。**

方向是对的（一个包、一个容器、按开关挂载、MVP 先打通最难的组合），
但方案里有 **3 个事实性判断错误**、**4 个必然导致“假关闭/泄漏”的容器级漏洞**，
以及 **2 个会直接让整个工具箱起不来的工程风险**。

其中最关键的一条：

> **方案里“官方会把 `Config` 自动投影成表单、6 个开关免费、中文免费”这个前提，
> 在 0.2.1-alpha.4 里不成立。**
> 不写 `.volatile()` 就没有表单；写了 `.volatile()`，`apply(ctx, config)` 拿到的
> 不是 `boolean` 而是 `Volatile<boolean>`，而且**开关变化不会重新执行 `apply`**。
> 方案第三节的宿主开关代码，按现在这个写法，**开关永远是“开”**。

建议改批为：

> **批准“方向 + 0.5 天可行性 spike”，不批准直接进入阶段 0 编码。**
> spike 只做一件事：用真实 DSH 验证“官方设置里能出现 6 个开关，且翻转开关能
> 不重启地让一个宿主工具消失/出现”。这一步过了，再按本报告第 8 节的放行条件开工。

---

## 1. 阻断项清单（按优先级）

| ID | 问题 | 我的证据 | 直接后果 | 修法（摘要） |
|---|---|---|---|---|
| **B1** | `Config` 没有 `.volatile()`；或加了 `.volatile()` 却仍按普通 boolean 读 | `dsh-settings/lib/index.js:122` `volatileForm()` 只收集 `meta.volatile` 字段；`:418` `describe()` 无 volatile 字段时**整条 entry 被跳过**；`:505` `write()` 拒绝非 volatile 路径。`schemastery/src/index.ts:521` 把 volatile 字段包成 `createVolatile`。`cordis-plugin-loader/lib/index.js:382` 只做 volatile-only 的 `_commitVolatile()`，**不 restart、不重跑 apply** | 不加 `.volatile()` → 没有表单、客户端读不到值；加了但用 `config.x !== false` → 永远为真，开关关不掉 | 6 个字段全部 `.volatile()`；宿主用 `config.x.get()`；宿主监听 `loader/volatile-update` 重新挂载/卸载；客户端用 `configForms` 快照读**普通值**（`plainConfig` 已解包） |
| **B2** | “官方自动表单”不存在；`plugins.row.config` 是**键控 slot**，必须自己写表单组件 | `dsh-client-ui-plugin-manager/lib/client.js:27` `rowConfigKey = pkg#rowId`；`:57` `rows: keysOf("plugins.row.config")`；`:2818` `renderSlot("plugins.row.config", {view:'page', form}, {entryKey:key})`；官方只有 agent-loop/shell/subagent/web-search 各自手写卡片 | 插件页不会自动出现 6 个开关；没有表单就没有开关 UI | 在客户端容器里注册 `plugins.row.config`，key = `dsh-toolbox#<rowId>`；表单用 `ctx.configForms.get(rowId)` 读/写；**这个表单必须常驻，不能被任何开关控制** |
| **B3** | `reconcile(DEFAULTS)` 先全挂、再异步对齐；`readSwitches().then(reconcile)` 没有 disposed 守卫 | 方案 2.3 的代码；容器 teardown 后 Promise 仍会 resolve | 启动瞬间产生全部副作用（插件汉化改写 DOM、草稿补丁、归档轮询、划词监听）；插件卸载后 Promise 回来**可能重新 mount**，`plugin-zh` 的 MutationObserver 就没人断了 | 用 `disposed` 标志 + reconcile 队列；**在拿到开关值之前不要挂任何不可逆功能**；把“缺省/读取失败”定义为 **off**，不是 on |
| **B4** | `mount` 不是事务；`live.set` 在 `mount` 返回后才写入；`mount` 期间可重入 | 方案 2.3 `live.set(f.id, f.mount(ctx, env) ?? noop)`；外层只在返回后检查 `mounted` | `mount` 注册了 3 个副作用、第 4 个抛错 → 前 3 个泄漏；`mount` 内同步触发一次 settings 事件 → 嵌套 reconcile 看到 `mounted=false`，**双挂**（双 slot、双 observer、双 storage patch） | `env.track()`/`DisposableList` 在 mount 前就接管每个 disposer；`mounting` 状态先占位；reconcile 串行化；每个 disposer 独立 try/catch |
| **B5** | `plugin-zh` 的“关闭”只断开 observer，**不还原已改写的 DOM**；`DOMContentLoaded` 监听也不摘；模块级状态不重置 | `dsh-plugin-zh/client.js:215` `node.nodeValue = zh`；`:318/:329` `addEventListener('DOMContentLoaded', begin, {once:true})`；`:333` 只 `observer.disconnect()`；`:164` 模块级 `state`；`:181` 全局 `__DSH_PLUGIN_ZH__` | 关掉后页面仍是中文（假关闭）；卸载后再挂载会双 observer；全局 API 和字典常驻 | 记录 `WeakMap<Text,{original,translated}>`，dispose 时仅当 `node.nodeValue===translated` 才还原；保存并摘掉 DOMContentLoaded listener；状态移入 feature 实例；卸载时清全局 |
| **B6** | `Storage.prototype` patch 无“所有权检查”、无 active 标志、无单例/引用计数 | `dsh-draft-saver/client.js:177` 取 `Object.getPrototypeOf(localStorage)`；`:266/:276` 换 `setItem/getItem`；`:291-296` 直接赋回 `origGet/origSet` | 覆盖后来第三方的 patch；双挂形成 wrapper 链；`sessionStorage` 被一并污染；卸载后仍被旧引用调用；极端情况下 wrapper 递归 → 页面卡死/栈溢出 | 只 patch `localStorage` 实例（或至少检查 `this`）；wrapper 带 `active` 标志；dispose 只在“当前函数仍是我”时还原；单例守卫；不删 `BACKUP_KEY`；失败时提示“需刷新” |
| **B7** | 20 行拼接共享一个 IIFE 作用域；容器 `return` 的位置没定义 | 现有 5 个客户端里大量同名顶层标识符：`h`、`t`、`NS`、`copyText`、`close`、`icon`、`state`、`pass`、`mountPanel`、`injectStyles`…；容器必须在 factory 末尾 `return`，feature 代码不能放在 `return` 之后 | 几乎必然 `SyntaxError: Identifier 'h' has already been declared` → **整个 client.js 不执行**，6 个功能全灭（连设置表单也没有） | 用 esbuild（devDependency，产物提交）或至少每个 feature 文件包一层独立 IIFE；文件间加分号；重复 id 检测；HMR 重复 eval 的 reset |
| **B8** | 宿主 `export const inject` 取并集 + 客户端 factory `inject` 取并集；`immediately` 合并 | `dsh-archive-manager/src/host/index.js:36` 需要 `webServer/storageDomain/workspaceRegistry/sessionPersistence`；`dsh-session-search/index.js:28` 需要 `sessionQuery`；客户端 archive 需要 `layout`、panel-menu 需要 `layout`、settings 需要 `configForms` | 任何一个可选服务缺失（desktop/headless/精简 profile）→ **整个 dsh-toolbox 不激活**，所有功能一起死；4 个原 `immediately:true` 合并后把 archive/plugin-zh 也变成开机即加载 | 模块级只 inject 最小公共集；每个 feature 用 `ctx.inject([...], cb)` 可选注入；客户端用 `ctx.get('configForms')` 降级；`immediately` 单独评估（见 6.2） |
| **B9** | 迁移没有“卸载旧 6 个 bundle/row + 处理重复 patch”的前置步骤 | 旧 `dsh-session-search/cordis.patch.yml` 也插入 `tool-session-search` 和 patch `session-query-sqlite`；旧 draft-saver 会 patch Storage；旧 quote-reply 会注册同一个 overlay | 双 `session_search`、双浮层、双 Storage patch（嵌套链）、双归档入口；`tools.register` 同名还可能直接抛错 | 迁移清单：先 `remove_bundle`/`set_bundle(false)` 旧 6 个；启动自检：发现同名工具/已打补丁的 Storage/旧 slot id 时**大声报错并拒绝重复注册** |
| **B10** | feature id 与 Config key 不一致；`next[f.id] !== false` 把 undefined 当 on | 方案 2.2 用 `id:'quote-reply'`，第五节用 `quoteReply`；2.3 用 `next[f.id]` | `readSwitches` 返回 `{quoteReply:false}` 时，`next['quote-reply']` 是 `undefined` → 仍然挂载，**开关无效** | `features.js` 里显式 `configKey`；`reconcile` 用 `configKey`；缺值按 `defaultOn`/off 策略，不能一律 on |

---

## 2. Q1：动态挂载/卸载，真的能完美清理所有副作用吗？

### 2.1 结论

**不能。按方案 2.3 的代码，至少有两个必然泄漏，一个高概率泄漏。**

“slot 挂载了但没卸载”和“MutationObserver 监听了没断开”不是理论风险，
而是**当前代码结构下可复现的路径**。

### 2.2 必然泄漏之一：卸载后 Promise 回来，重新挂载

方案 2.3：

```js
reconcile(DEFAULTS);
readSwitches(ctx).then(reconcile).catch(() => {});
const offWatch = watchSwitches(ctx, reconcile);

ctx.effect(() => () => {
  offWatch();
  for (const [, dispose] of live) { try { dispose(); } catch {} }
  live.clear();
}, 'toolbox: dispose all features');
```

`readSwitches` 是异步的（要走 `ctx.remote.settings.describe()` 或 `configForms` 镜像）。
如果用户在它 resolve 之前禁用/卸载了插件：

1. teardown 执行：`offWatch()`、遍历 `live` 全部 dispose、`live.clear()`；
2. 之后 Promise resolve，`reconcile(next)` 照常执行；
3. 此时 `live` 是空的，`want && !mounted` 成立 → **重新 mount**；
4. `plugin-zh` 的 `installTranslator` 会 new 一个 `MutationObserver` 并 `observe(document.body,{subtree:true})`；
5. 这个 observer 的 disposer 已经没有任何人持有 → **永久监听**（前提是 mount 在已 dispose 的 ctx 上仍能走到 `new MutationObserver`）。

`ctx.effect` 对“卸载后再注册”的行为可能是抛 `INACTIVE_EFFECT`，也可能静默失败，
取决于具体服务；但**无论哪种，代码都没有处理**。
如果 `mount` 在 `ctx` 已 dispose 后仍完成了一部分 DOM/定时器副作用，那就是裸泄漏。

**修法（必须）**：

```js
let disposed = false;
let queue = Promise.resolve();

function schedule(next) {
  queue = queue
    .then(() => { if (!disposed) return reconcile(next); })
    .catch((err) => console.error('[dsh-toolbox] reconcile failed', err));
  return queue;
}

readSwitches(ctx).then((v) => schedule(v)).catch(() => {});

ctx.effect(() => () => {
  disposed = true;          // 先置位，再拆
  offWatch();
  ...
});
```

并且 **teardown 之后不得再调用任何 mount**；在 `mount` 开头再检查一次 `disposed`。

### 2.3 必然泄漏之二：“先按默认值全挂一遍”会产生不可逆副作用

`reconcile(DEFAULTS)` 的意图是“不阻塞首屏”，但它实际上做了：

| 功能 | 启动瞬间的副作用 | 关掉后能否收回 |
|---|---|---|
| `plugin-zh` | 立刻 `pass(document.body)`，把文本节点改成中文；弹 toast | **不能**。observer 断了，已改写的文本不会变回英文 |
| `draft-saver` | patch `Storage.prototype`；期间任何草稿读写都会被拦截，可能写入备份 key、弹恢复提示 | patch 能还原；但已写入的 `BACKUP_KEY` 和 `notice` 状态不会自动消失 |
| `archive-panel` | 向 `document.body` 挂 `MutationObserver`；创建面板容器；plain 路径下 `setInterval(...,3000)` + `fetch` | 容器移除后 interval 下一拍会自清；但 `<style>` 永远留在 `<head>`；fetch 可能还在飞 |
| `quote-reply` | 挂 7 个 document/window 监听 + 2 个 slot | 能收回（组件 effect 清理） |
| `panel-menu` | 注入隐藏侧栏行的 `<style>`（随 trigger 组件走）；读 slot ledger | 能收回；但模块级 `menuState` 不重置，重开时可能是“打开”状态 |

**“零运行时开销”这句话不成立**：启动时所有功能都真的跑了一遍，
只是随后被拆掉。对 `plugin-zh` 来说，这个过程是**用户可见且不可逆**的。

**修法**：不要在设置值未知时挂载不可逆功能。可选策略：

- **A（推荐）**：用 `localStorage` 同步缓存上一次的开关值，启动先用缓存；
  缓存缺失时**全部视为 off**，等真实值到了再逐个挂。
- **B**：只挂“可逆且无感”的功能（quote-reply 的监听可以等 slot），
  不可逆功能（plugin-zh、draft-saver）必须等真实值。
- **C**：宿主把开关值通过一次极小的 bootstrap 请求下发；仍然要处理失败。

无论哪种，**“读取失败/缺值 = off”**，不能是 on。

### 2.4 高概率泄漏：`mount` 不是事务

```js
live.set(f.id, f.mount(ctx, env) ?? noop);
```

如果 `mount` 内部是：

```js
const offMenu = ctx.slots.inject(...);   // 注册成功
const offSink = ctx.slots.inject(...);   // 注册成功
throw new Error('third thing failed');   // 这里抛
```

那么 `f.mount()` 没有返回，容器 catch 住错误、记进 `errors`，
**`offMenu`/`offSink` 没有任何人持有**。`ctx.slots.inject` 内部虽然把注册挂在 fiber 上，
插件卸载时会兜底；但 **toggle off 不会**——用户看到开关关了，slot 还在，
直到整个插件卸载。对 DOM/observer/storage 这类不在 fiber 上的副作用，就是纯泄漏。

同样，方案的 `dispose` 写法：

```js
try { live.get(f.id)(); } catch (err) { console.error(err); }
live.delete(f.id);
```

一个复合 disposer `() => { offSink(); offMenu(); }` 如果 `offSink()` 抛错，
`offMenu()` 永远不执行；容器 catch 后还把 `live` 删了，**没有第二次机会**。

**修法**：在调用 `mount` 之前就给它一个“记账本”：

```js
function createScope() {
  const undo = [];
  let closed = false;
  return {
    track(d) {
      if (typeof d !== 'function') throw new TypeError('disposer must be a function');
      if (closed) { try { d(); } catch {} ; return () => {}; }
      undo.push(d);
      return d;
    },
    dispose() {
      if (closed) return;
      closed = true;
      let first;
      for (const d of undo.splice(0).reverse()) {
        try { d(); } catch (e) { first ??= e; console.error(e); }
      }
      if (first) throw first;
    },
  };
}
```

每个 feature 的 `mount(ctx, env)` 必须通过 `env.track(...)` 登记**每一个** disposer；
`env.track` 在 mount 抛错时由容器统一回滚。硬规矩：
**没有走 `env.track` 的副作用，不允许进容器。**

### 2.5 重入 / 双挂

`reconcile` 不是可重入安全的：
它先读 `live.has(f.id)`，再调 `f.mount(...)`，**最后**才 `live.set(...)`。
如果 `mount` 内部同步触发了另一次 `reconcile`（例如某个 feature 在 mount 时
dispatch 了一个 settings 事件、或 slot 注册同步触发了 watch 回调），
嵌套调用会看到 `mounted === false`，于是**再挂一次**。

后果：

- `quote-reply`：`sinkHandlers` 里两个 handler；关掉后还剩一个，
  引用着已卸载 composer 的 `inputActions` → 引用泄漏 + 可能的错误写入。
- `draft-saver`：`installGuard` 第二次调用时，`origGet/origSet` 已经是**第一次的 wrapper**；
  两次 dispose 的还原顺序只要错一次，`Storage.prototype.setItem` 就永远停在 wrapper 上
  （详见第 4 节）。
- `plugin-zh`：两个 observer，dispose 只断一个 → 另一个永久监听 + 全树文本扫描。

**修法**：`reconcile` 串行化 + `mounting` 占位：

```js
const state = new Map(); // id -> 'mounting' | 'mounted' | 'off'
```

在调用 `mount` 之前写 `mounting`；`mount` 成功后写 `mounted`；
抛错则回滚并写 `off`。嵌套 reconcile 看到 `mounting` 直接跳过。

### 2.6 各功能的真实清理债务（按当前代码）

| 功能 | 关闭时能收回 | 收不回 / 需要额外处理 |
|---|---|---|
| `quote-reply` | 7 个监听（组件 effect）、2 个 slot、locale 字典 | `sinkHandlers` 是模块级 Set；双挂会残留；`closeTimer` 有组件级清理，OK |
| `draft-saver` | slot、locale 字典、Storage patch（有条件） | `notice`/`noticeListeners` 是模块级；备份 key **不能删**；patch 还原见第 4 节 |
| `panel-menu` | trigger/overlay slot、隐藏样式（随组件）、keydown | `menuState`/`listeners` 模块级；关闭时若菜单开着，重开仍是 open |
| `archive-panel` | `entry.remove()`、两个 observer/disconnect、document 监听、interval 自清、React root unmount、`html` 属性 | **`injectStyles` 追加的 `<style>` 永不移除**（`src/client/client.js:57`）；`renderPlain` 里的 `controller.subscribe` 从不 unsubscribe；dispose 中任一语句抛错，后面的 `root.unmount/container.remove` 都不执行 |
| `plugin-zh` | observer.disconnect、toast 移除 | **已改写的文本不还原**；`DOMContentLoaded` listener 不摘；`state`/`toastShown`/`window.__DSH_PLUGIN_ZH__` 常驻；`unknown` Set 可增长 |
| `session-search`（宿主） | `ctx.tools.register` 的 disposer（如果收集了） | 现在 `dsh-session-search/index.js:271` 直接调用 `register`，**没有保存返回值**；迁移时必须保存并返回 |

### 2.7 关于 “slot 挂了但没卸载”

单看 slot 本身，风险相对低：`ctx.slots.inject` 内部就是 `ctx.effect`，
插件卸载时会兜底；它的返回 disposer 也是幂等的（`dsh-client-ui-renderer/lib/client.js:1368`）。
真正的风险是：

- **双挂**导致同一个 slot id 注册两次，一个 disposer 丢失；
- 在 React 渲染过程中同步 dispose，触发 “unmount during render” 类警告；
- 注册到**别的 context**（例如 `agent.ctx`）但没有在自己的 effect 里再持有一次，
  文档 `practices.md` 明确要求“双 ownership”。

**建议**：container 的 reconcile 用 `queueMicrotask` 串行执行，
不要从 React 事件回调里同步 dispose；slot 注册一律通过
`ctx.slots.inject(key, () => ctx.slots.register(...))`，不要裸 `register`。

---

## 3. Q2：宿主侧开关（session_search）的生死线与兜底

### 3.1 方案对 Config 的理解错了两层

方案假设：

```js
export const Config = Schema.object({
  sessionSearch: Schema.boolean().default(true),
});
export function apply(ctx, config) {
  if (config.sessionSearch !== false) { ... }
}
```

在 0.2.1-alpha.4 里，这条链是断的：

1. **不 `.volatile()` → 没有表单。**
   `dsh-settings/lib/index.js:122` 的 `volatileForm(schema)` 只保留
   `meta.volatile` 的字段；一个都没有就返回 `undefined`，
   `describe()` 在 `:418` 直接 `return []`，这条 entry 不会出现在设置里。
   也就是说：**你连开关都看不到。**
2. **加了 `.volatile()` → `config.sessionSearch` 不是 boolean。**
   `schemastery/src/index.ts:521` 会把它包成 `createVolatile(value)`；
   `apply(ctx, config)` 收到的是 `{ get(), [write]() }`。
   `config.sessionSearch !== false` 永远为 `true` → **工具永远装上**。
3. **volatile 变化不会重跑 `apply`。**
   `cordis-plugin-loader/lib/index.js:382-384` 在 `equalExceptVolatile` 为真时走
   `_commitVolatile()`，只做 `updateVolatile(ref, source)`（原地改 ref）并 emit
   `loader/volatile-update`，**不 restart、不 dispose/apply**。
   所以“靠 apply 重新注册/注销工具”这个思路，在 volatile 模式下不成立。

**结论**：方案第 3.4 节和验收第 5 条，按当前代码**必然失败**，
而且失败原因会被误判为“DSH 不支持热开关”。

### 3.2 三条可行路径（请选一条，不要混）

| 路径 | 怎么做 | 优点 | 缺点 / 风险 | 建议 |
|---|---|---|---|---|
| **A. 非 volatile + 行重启** | `Config` 不 `.volatile()`，通过 YAML/profile patch 改值；loader 走普通 lifecycle，`apply` 重跑 | 宿主注册/注销天然生效 | **官方 `settings.write` 明确拒绝非 volatile 路径**（`:505`），所以没有 UI 开关；只能让人手改 YAML | ❌ 不满足“面板里有开关”的产品目标 |
| **B. volatile + `loader/volatile-update`** | 6 个字段 `.volatile()`；`apply` 用 `.get()` 初始挂载；`ctx.on('loader/volatile-update', reconcileHost)` 重挂/卸载 | 真正“开关即生效”，工具能从 schema 消失 | 需要正确监听事件；切换瞬间在飞的 tool call 会拿到 `unknown tool` | ✅ **首选** |
| **C. volatile + guard/pre-execute 拦截** | 工具一直注册；`ctx.tools.guard(() => config.sessionSearch.get() ? undefined : '...')` 或 `tools/pre-execute` 返回 `{kind:'deny'}` | 实现最简单；不依赖事件；Volatile ref 原地更新，读到的一定是最新值 | 工具仍在模型工具表里 → 可能被反复调用；pre-execute 是全局 waterfall，写错会**影响所有工具** | ⚠️ 只作为 B 的**兜底**，不作为主方案 |

**推荐组合**：B + C。B 负责“从工具表里消失”，C 负责“切换过渡期/事件丢失时也不执行”。
两者都读同一个 `config.sessionSearch.get()`。

```js
// 宿主（示意）
export const Config = Schema.object({
  sessionSearch: Schema.boolean().default(true).volatile(),
  // ...
});

export function apply(ctx, config) {
  let offTool;
  const sync = () => {
    const want = config.sessionSearch.get() !== false;
    if (want && !offTool) offTool = installSessionSearchTool(ctx);
    if (!want && offTool) { offTool(); offTool = undefined; }
  };
  ctx.effect(() => {
    const offEvent = ctx.on('loader/volatile-update', sync);
    sync();
    return () => { offEvent(); offTool?.(); offTool = undefined; };
  }, 'toolbox: host switches');
}
```

> 注意：`ctx.on` 的返回值是 disposer；`ctx.effect` 的回调返回它即可。
> 不要在 `loader/volatile-update` 里做 `settings.update()`（会重入 `configEditor` 的文件锁）。

### 3.3 兜底“工具还在但拦截执行”，会不会让 AI 崩溃或无限重试？

**不会“崩溃”，但有两个真实成本，而且实现方式选错会把整个工具系统拖下水。**

从 `dsh-tools/lib/index.js` 的实际行为看：

- 拒绝会被物化成一条 **tool result**：
  `content: [{type:'text', text:'Error: <reason>'}], isError: true`
  （`:3318-3330`），agent loop 继续，不会抛到外层。
- 工具被移除后，如果模型还在调它，会得到 `ToolNotFoundError`
  （`code:'UNKNOWN_TOOL'`，`:2623`），同样是一条 tool error，不是崩溃。

真正的风险是：

1. **重试烧 token**：模型看到“工具存在但报错”，弱模型可能连续重试。
   DSH 有轮次/步数上限会兜住，但在兜住之前已经浪费了时间/token。
   如果 denial 文案只是“已关闭”，模型很可能换个参数再试。
2. **全局 waterfall 的爆炸半径**：如果用 `tools/pre-execute` 实现，
   这个 listener 对**所有工具**生效。忘记 `return next()` 会让 `gate` 变成
   `undefined`，下一行 `gate.kind` 直接 TypeError（被 catch 成 tool error）；
   如果返回一个永不 resolve 的 Promise，**所有工具调用会挂住**。
   这不是 JS 死锁，是“工具系统假死”，比崩溃更难查。
3. **看不到的“假开关”**：如果代码里仍然写 `config.sessionSearch !== false`，
   兜底也会永远放行——用户以为关了，其实没关。

**正确写法（按优先级）**：

1. **首选**：`ctx.tools.register` 返回的 disposer，在开关关闭时真正 dispose；
2. **同时**：
   ```js
   ctx.tools.guard((exec) =>
     exec.name === 'session_search' && !config.sessionSearch.get()
       ? 'session_search is disabled by the user; do not retry; use listSessions or ask the user'
       : undefined,
   );
   ```
   —— guard 是同步、单点；**但它对全局所有工具生效，必须自己先判断 `exec.name`**，
   漏了这个判断就会把所有工具一起 deny（`:2989`）；
3. **如果还想从模型工具表里消失**：在 `agent/created` 里对每个 `agent.ctx`
   用 `ctx.tools.restrict({ deny: ['session_search'] })`（`:2972`，需要 scoped context），
   并在开关变化时 dispose/重建这个 restriction；
4. **不推荐**：`tools/pre-execute` 做永久 deny（爆炸半径大、仍不隐藏工具）。

**denial 文案要满足**：说明“用户明确关闭”、说明“不要重试”、给出替代路径。
不要只写 `Error: disabled`。

### 3.4 “生死线”测试怎么设计才可信

方案里的验收第 5 条是“我在会话里实测调 `session_search` 调不到”。
这个测法**不可信**：模型可能不调、可能调了旧工具、也可能在另一个 profile/session 里。

建议改成可判定的断言：

1. 打开设置面板，把 `sessionSearch` 关掉；
2. 在同一页面**不刷新**，通过 `cordis_inspect_query`（或 `tools` 服务的 view）
   查当前 agent 可见工具列表，断言 `session_search` **不在** schema 里；
3. 再打开，断言它**回来**；
4. 在“关闭”状态下，用一个历史 tool call（或直接 `ctx.tools.execute`）强制调用，
   断言返回的是 `UNKNOWN_TOOL` 或明确的 deny，而不是执行结果；
5. 记录一次“切换时正在飞”的调用结果：应该是 tool error（可接受），
   不能是页面崩溃/会话卡死。

**这一步必须在真实 DSH 里做，不能只靠 fake ctx 单测。**

---

## 4. Q3：`Storage.prototype` patch 的后果与测试设计

### 4.1 现状（我读到的代码）

`dsh-draft-saver/client.js`：

```js
const proto = Object.getPrototypeOf(localStorage);   // Storage.prototype
const origGet = proto.getItem;
const origSet = proto.setItem;

proto.setItem = function patchedSetItem(key, value) { ... };
proto.getItem = function patchedGetItem(key) { ... };

uninstallGuard = () => {
  proto.getItem = origGet;
  proto.setItem = origSet;
  uninstallGuard = null;
};
```

这段代码在“单实例、单次挂载、没有别人同时 patch”时是对的；
一旦进入容器的反复 mount/unmount，就有 6 类风险。

### 4.2 还原不当的严重后果

| # | 场景 | 后果 | 严重度 |
|---|---|---|---|
| 1 | **双挂**（reconcile 重入 / HMR 双 eval / 旧 draft-saver 未卸载） | 第二次 mount 的 `origSet` 是第一次的 wrapper；dispose 顺序错一次，`Storage.prototype.setItem` 永远停在 wrapper 上 → **假关闭**，功能“关了还在跑” | 🔴 |
| 2 | **wrapper 链** | 双挂会形成 `P2 → P1 → O` 的链；当前实现用保存的 `origSet` 转发，单实例下**不会成环**，但双挂/还原顺序错会留下一条永久 wrapper（假关闭）。**如果实现时改成从 `proto.setItem` 取“原函数”（而不是保存的 `origSet`），或重复捕获后再还原，就可能自递归** → `RangeError: Maximum call stack size exceeded`，整个页面所有 localStorage 读写崩掉 | 🟠（当前代码主要是假关闭；自递归取决于实现） |
| 3 | **覆盖第三方的 patch** | 如果 DSH 或别的插件在你之后 patch 了 `getItem`（比如加密、配额、审计），你 dispose 时直接 `proto.getItem = origGet` 会把**它的 patch 一起抹掉**，且没有任何报错 | 🟠 |
| 4 | **跨 Storage 污染** | `Object.getPrototypeOf(localStorage)` 是 `Storage.prototype`，`sessionStorage` 共享同一个原型；代码只判断 key 前缀、不判断 `this`，所以 `sessionStorage` 里的同名草稿 key 也会被镜像进 `localStorage.BACKUP_KEY`，读也会被替换 | 🟠 |
| 5 | **还原失败静默** | 如果 `Storage.prototype` 被 `Object.freeze`/属性改成 non-writable（或某些浏览器/扩展环境），赋值在严格模式下抛错、非严格模式下静默失败；`uninstallGuard = null` 已经执行，容器以为关掉了 | 🟠 |
| 6 | **旧引用继续跑** | 别的代码在 patch 前缓存了 `const get = Storage.prototype.getItem`；dispose 只换属性，**它手里的引用仍是 wrapper**，继续写备份/弹提示；`backupRead/backupWrite` 闭包和 `notice` 状态因此长期存活 | 🟡 |
| 7 | **数据丢失** | 如果 dispose 里顺手 `removeItem(BACKUP_KEY)`（方案没写，但实现时很容易“清理干净”），用户最后一份未发送草稿就没了；这是**用户数据**，不是缓存 | 🔴 |
| 8 | **HMR / 多副本** | `dsh-client-hmr` 重载模块时，旧 fiber 的 dispose 与新 mount 交错；没有所有权检查就会互相覆盖 | 🟠 |

### 4.3 怎么设计才算“绝对安全”

**最低要求（必须全做）**：

1. **收窄目标**：优先 patch `localStorage` **实例**（`localStorage.setItem = ...`），
   而不是 `Storage.prototype`；这样 `sessionStorage` 和其他 Storage 实例天然不受影响。
   如果必须 patch 原型，wrapper 里检查 `this === localStorage`，否则直接走 `orig`。
2. **所有权检查**：dispose 只在
   `proto.getItem === patchedGetItem && proto.setItem === patchedSetItem` 时还原；
   否则说明有人在你之后改了，**不要覆盖**，记录警告并标记“需刷新”。
3. **active 标志**：wrapper 内部先判断 `active`；dispose 先置 `active=false`，
   再尝试还原。这样即使旧引用还在，它也退化成透明转发，不再写备份/弹提示。
4. **单例 / 引用计数**：模块级 `installed` 守卫；重复 mount 返回同一个 disposer，
   或者直接拒绝第二次 mount 并报错。绝不能出现两条 wrapper 链。
5. **幂等**：dispose 调两次不报错；`uninstallGuard=null` 后再调是 no-op。
6. **不删用户数据**：dispose 不碰 `BACKUP_KEY`；如果确实要清理，必须由用户显式操作。
7. **失败可见**：还原失败时不要静默；在设置面板/控制台明确写“关闭需要刷新页面”，
   并把开关状态标成“待重启”而不是“已关闭”。
8. **标记**：给 wrapper 加一个 `Symbol.for('dsh.draft-saver.patch')` 标记，
   启动时如果发现已有标记（旧插件/旧副本），拒绝重复 patch 并提示先卸载旧的。

### 4.4 测试矩阵（建议直接照这个写）

> 现有的 `test/draft.test.mjs` 用 `FakeStorage` 类 + `globalThis.localStorage`；
> 这个 fake 会让 `Object.getPrototypeOf(localStorage)` 等于 `FakeStorage.prototype`，
> 所以**两个 `FakeStorage` 实例共享原型**——正好可以用来测 `sessionStorage` 污染。

| # | 测试 | 断言 |
|---|---|---|
| 1 | 还原身份 | mount 前保存 `origGet/origSet`；dispose 后 `proto.getItem === origGet && proto.setItem === origSet`（严格相等，不是行为相等） |
| 2 | 幂等 | `dispose(); dispose();` 不抛错，第二次是 no-op |
| 3 | 重复 mount | 第二次 mount 要么复用同一 disposer，要么明确抛错；不允许出现两条 wrapper |
| 4 | 交叉 dispose | mount A → mount B → dispose A → dispose B（模拟双挂）；最终 `proto.setItem` 必须是原始函数；中间任何时刻不能形成环 |
| 5 | 第三方 patch 保护 | 先装一个 `spy = (k,v)=>orig(k,v)` 替换 `proto.setItem`；再 mount toolbox；再让第三方在 toolbox 之后 patch；dispose toolbox；断言第三方 patch **仍在**（toolbox 不能覆盖） |
| 6 | 跨 Storage | `sessionStorage.setItem('dsh.conversation.x', '...')`；断言 `localStorage.BACKUP_KEY` **没有**被写；`sessionStorage.getItem` 不被替换 |
| 7 | 还原失败 | 把 `proto.setItem` 定义成 non-writable（或 `Object.freeze(proto)`）；mount 后 dispose；断言不崩溃、有明确错误/“需刷新”标记，且不会错误地报告“已关闭” |
| 8 | 数据保留 | mount 时写入草稿 → dispose → 断言 `BACKUP_KEY` 仍在、内容正确；下一次 mount 能恢复 |
| 9 | 关闭后透明 | dispose 后写草稿；断言没有新的备份写入、没有 notice 事件（用 spy 监听 `publishNotice` 的等价通道） |
| 10 | 配额异常 | 让 `origSet` 抛 `QuotaExceededError`；断言原异常语义保留、无递归、dispose 仍可执行 |
| 11 | 旧引用 | mount 前缓存 `const old = proto.setItem`；dispose 后调用 `old.call(localStorage, 'dsh.conversation.x', '...')`；断言它已退化为透明转发（`active=false`），不写备份 |
| 12 | 真实浏览器 E2E | Playwright/手工：打开 DSH 页面 → 记录 `Storage.prototype.setItem` → 关掉草稿保险箱 → 控制台断言 `localStorage.setItem` 已回到原始函数；再刷新，断言没有重复 patch |
| 13 | HMR / 双 eval | `vm` 里对同一个 `window` 执行两次 artifact；mount A → mount B → dispose A → 断言最终无 wrapper 链 |
| 14 | 监听器/定时器计数 | fake `MutationObserver`/`setInterval` 记录 live 数量；mount/unmount 10 次后断言 0 |

**注意**：Node 默认没有 `localStorage`（Node 22+ 需 `--experimental-webstorage`）。
现有测试是注入 fake，这没问题；但 fake 必须真实模拟“原型方法 + `this`”，
否则测试会给假信心。第 12 条的真实浏览器验证不能省。

---

## 5. Q4：20 行拼接 vs esbuild

### 5.1 直接风险：不是理论，是几乎必然

方案说：

```js
const HEAD = ';(function(){ const __toolbox = { features: [], defineFeature(f){ this.features.push(f); } };';
const TAIL = ' window.__TOOLBOX_FEATURES__ = __toolbox.features; })();';
```

然后把 `src/client/**` 拼进去。问题是：**所有 feature 文件共享同一个函数作用域。**

现有代码里的顶层标识符（我随手 grep 的，不是全部）：

| 文件 | 顶层名字 |
|---|---|
| `dsh-quote-reply/client.js` | `h`、`t`、`NS`、`copyText`、`close`、`icon`、`item`、`sinkHandlers` |
| `dsh-draft-saver/client.js` | `h`、`NS`、`copyText`、`notice`、`noticeListeners`、`installGuard`、`EMPTY_DRAFT` |
| `dsh-panel-menu/client.js` | `h`、`t`、`NS`、`listeners`、`menuState`、`setMenu`、`injectStyles` |
| `dsh-plugin-zh/client.js` | `state`、`pass`、`lookup`、`DICT`、`TOAST_ID`、`toast` |
| `dsh-archive-manager/src/client/client.js` | `apply`、`inject`、`injectStyles`、`mountPanel`、`mountSidebarEntry`、`createController`、`ACTIVE_ATTR` |

只要两个文件都写 `const h = React.createElement`，
浏览器在**解析阶段**就抛：

```
Uncaught SyntaxError: Identifier 'h' has already been declared
```

整个 `client.js` **一行都不执行** → 6 个功能全灭，连“设置表单”都不会出现。
这不是“潜在风险”，是**迁移后第一次加载就大概率发生**。

除了重名，还有：

1. **容器 `return` 的位置**：现在的单文件插件是
   `window.__ModuleLoader__.load({ factory(require){ ...; return {inject, apply}; } })`。
   如果把容器放在 feature 前面、`return` 也在前面，后面的 feature 代码**永远不执行**；
   如果放在 `return` 后面，还可能直接语法错误。拼接脚本必须精确控制
   “factory 开 → 容器函数体（不含 return）→ features → factory return/收尾”。
2. **ASI**：文件 A 以 `}` 结尾、文件 B 以 `(`/`[` 开头，会被解析成调用/索引。
   必须在每个文件之间插入 `;\n`。
3. **严格模式**：每个文件开头的 `'use strict'` 在拼接后不再是 directive prologue；
   如果外层 IIFE 是 strict，所有文件都被 strict 化，可能触发原本不报的错。
4. **重复注册**：`defineFeature` 不查重；HMR 二次 eval 会 push 两份；
   `window.__TOOLBOX_FEATURES__` 是全局可变数组，任何脚本都能 push。
5. **容器在 feature 之前读数组**：如果 `DEFAULTS`/`features` 在模块 eval 时快照，
   会拿到空数组；必须延迟到 `apply()` 里读。
6. **构建可重复性**：`readdir` 顺序依赖 OS；Windows CRLF 与仓库 LF 可能让
   `concat-fresh` 的逐字节比对**误报**；文件 BOM 会让拼接后的 JS 解析失败。
   需要显式 `sort()`、`.gitattributes`、去 BOM、统一 `\n`。
7. **调试**：100 KB 单文件，报错行号无法映射回源文件；没有 sourcemap，
   线上排查只能靠搜字符串。
8. **爆炸半径**：任何一个 feature 的**顶层**代码抛错（不只是 mount），
   整个 IIFE 失败，全部功能陪葬。esbuild 的模块作用域至少能把“名字冲突”
   降级为构建错误，而不是运行时全灭。

### 5.2 方案 B 的真正成本不是 20 行

一个“能用”的拼接脚本至少要：

- 每个文件独立 IIFE 包裹（解决重名）；
- 文件间 `;\n` 分隔；
- 显式排序 + BOM/换行归一；
- `defineFeature` 查重 + id 校验；
- 二次 eval 的 reset（HMR/测试）；
- factory 开头/结尾的精确拼接；
- 文件级 sourceURL 或 banner（便于定位）。

这已经是 40–60 行，而且每加一条规则就多一个测试。
**“20 行零依赖”是低估。**

### 5.3 我的建议

**用 esbuild，但把产物提交进仓库。**

- esbuild 只是 **devDependency**，不是运行时依赖；
  DSH 运行时只看到 `client.js`，完全符合“零运行时依赖/零构建器”的目标。
- `format: 'iife'` + `bundle: true` + `platform: 'browser'` + `external: ['react']`
  （或按 DSH 的模块表处理），产物就是单文件。
- 每个 feature 是独立 ESM 模块，**天然有模块作用域**，重名不会互相污染；
  还能用 TypeScript、sourcemap、minify（可选）。
- 用 `--metafile` 或 `concat-fresh` 类似的测试校验产物与源码同步。

示意：

```js
// tools/build.mjs（devDependency: esbuild）
import { build } from 'esbuild';
await build({
  entryPoints: ['src/client/index.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'client.js',
  external: ['react'],          // DSH 的模块表提供
  sourcemap: false,             // 或 true + 提交 .map
  banner: { js: '/* generated by tools/build.mjs; do not edit */' },
  legalComments: 'none',
});
```

如果坚持“零依赖”，**至少**要给每个 feature 文件包一层：

```js
;(function () {
  'use strict';
  // ... feature 文件内容 ...
})();
```

并且 `__toolbox` 从外层闭包拿。这样能解决 90% 的重名问题，
但仍然解决不了容器 `return` 顺序、HMR reset、sourcemap。
**我不推荐为了省一个 devDependency 去手写拼接。**

---

## 6. 其他架构问题（不在你四个问题里，但会影响批不批）

### 6.1 宿主 `inject` 并集 = 一个服务缺失，全部功能死

合并后的 `index.js` 如果写：

```js
export const inject = ['tools', 'webServer', 'storageDomain', 'workspaceRegistry',
                       'sessionPersistence', 'sessionQuery', 'settings'];
```

那么任何一个 profile 缺少其中一个（desktop/headless/精简 web），
**整个 dsh-toolbox 宿主插件都不会激活**，包括你只想用的 session_search。
这与方案自己说的“一个功能崩不影响其它功能”直接矛盾。

**修法**：模块级只 inject 最小公共集（比如 `tools`），
每个 feature 用可选注入：

```js
ctx.inject(['webServer', 'storageDomain', 'workspaceRegistry', 'sessionPersistence'], (ctx) => {
  // archive feature
});
```

这样 archive 在 desktop 上不会拖死 session-search。

### 6.2 客户端 `immediately` 合并改变了启动行为

4 个原插件是 `immediately: true`，archive/panel-menu 不是。
合并后只能有一个 `immediately` 值：

- 若 `true`：archive/plugin-zh 也变成开机即加载，
  额外拉起 `dsh-client-ui-workspace`、`dsh-client-runtime`、`dsh-client-connection`；
- 若 `false`：quote-reply/draft-saver 的“立即生效”可能退化。

方案说“行为保持一致”是不准确的。建议实测首屏时间 + 功能可用时间，
再决定；不要把 `immediately` 当无关紧要的字段。

### 6.3 `session-query-sqlite` 的 patch 不是“常驻”，是“随 bundle 常驻”

方案 3.3 说“让这条 patch 常驻”。准确说法是：
**只要 dsh-toolbox 这个 bundle 处于启用状态，patch 就在**。
用户一旦禁用整个 bundle，FTS patch 也会消失，侧栏搜索退化为标题匹配。
如果将来要“独立于工具箱开合”，确实需要第二个 bundle（方案已经提到，但应该写进
“已知限制”，而不是“常驻”）。

另一个迁移风险：旧的 `dsh-session-search` bundle 里也有同一段 patch。
如果新旧同时启用：

- `session-query-sqlite` 的 config 会被后一层覆盖（可能值相同，通常无害）；
- `tool-session-search` 会被插入两次 → 同名工具注册可能直接抛错，
  或者后注册的覆盖前者（取决于 layer）；
- 用户会看到两个 `session_search`。

**必须在 README/迁移脚本里明确：先卸载旧 bundle，再装 toolbox。**

### 6.4 “一个包”带来的爆炸半径与版本耦合

6 个功能共享一个 `version`、一个 `client.js`、一个 `apply`：

- 任何一个小改动都要为整个工具箱发版；
- 任何一个 feature 的顶层代码/依赖出问题，全部功能不可用；
- 用户不能单独升级/回滚某个功能；
- 6 个独立仓库的 issue/README/历史需要归档说明。

这些不是“不能做”，但方案只写了收益，没写代价。建议在 README 里明确
“monolith 的取舍”，并保留每个 feature 的独立测试，降低回滚成本。

### 6.5 archive-manager 的宿主依赖与打包

`dsh-archive-manager/src/host/index.js` 直接
`import { workspaceDomainSpec } from '@deepseek-ai/dsh-workspace'`，
而 `package.json` 只声明了 `schemastery`。它现在能跑，是因为本机安装方式/解析器
的特殊性（我实测从 `~/.dsh/profiles/web/node_modules/dsh-archive-manager`
里 `import.meta.resolve` 能解析到 harness 安装目录）。
合并成新包、改用 `plugin_manager install_bundle` 安装后，
**这个解析是否仍然成立，必须实测**。如果失败，archive 会在激活时直接 import error，
而 `export const inject` 的并集会让整个工具箱一起失败（见 6.1）。

另外，`archive` 是 web-only（依赖 `webServer`），`session-search` 在 desktop 也装了。
合并后 `platform: 'web'` 会让 desktop 上的客户端功能消失；
如果这是有意的，请在 README 写清楚；如果不是，需要按 profile 拆分。

### 6.6 “一个 row”的验收描述不准确

装一个 bundle 会在插件页产生：

- 1 个 **package/bundle 卡片**；
- 1 个 **row**（`dsh-toolbox`）。

所以验收 #1 应该说“只多出一个包 + 一行”，而不是“只多出一行”。
另外，row 被禁用（`set_plugin(false)`）时，**客户端模块是否还会 apply**，
我没有在运行时验证；从源码看，客户端模块是按包级 `dsh.client` 清单加载的，
行级开关只切 host entry。**如果客户端仍然 apply，而它又读不到 Config（row 不活跃
→ settings namespace 消失），按方案“缺值=on”的逻辑，6 个功能会全部以默认值运行。**
这是一个必须实测的高危场景：**用户以为“整行关掉”，其实客户端还在跑。**
正确策略：`configForms` 快照里 namespace 不存在/status=unavailable → **全部 off**。

### 6.7 设置表单本身不能被开关控制

方案的 6 个开关控制 6 个功能，但**设置表单**是第 7 个东西：

- 如果把它也做成 registry 里的 feature，并且 `defaultOn: true`，
  用户关掉它就再也打不开其他开关（把自己锁在门外）；
- 如果 `defaultOn: false`，第一次装好没有 UI 可开。

**它必须是容器级、常驻的 UI**，不参与 `reconcile`。

### 6.8 测试计划里缺的几类

方案列了 6 个测试文件，方向对，但缺少：

- **artifact 加载测试**：用 fake `window` 加载真实 `client.js`，断言
  `__TOOLBOX_FEATURES__.length === 6`、id 唯一、顺序正确。
  这能第一时间抓住 5.1 的语法错误/漏文件。
- **泄漏计数测试**：fake `MutationObserver`/`setInterval`/`addEventListener`，
  mount/unmount N 次后断言 live 数为 0。
- **重入/双挂测试**：mount 期间触发 reconcile，断言 mount 只调用一次。
- **设置缺失/失败测试**：`readSwitches` reject 时，断言不可逆功能**没有**挂载。
- **旧插件共存测试**：模拟已存在 `session_search`/已 patch 的 Storage，
  断言新容器拒绝重复注册并给出可读错误。
- **真实页面 E2E**：至少覆盖“关掉草稿保险箱 → `localStorage.setItem` 身份还原”
  和“关掉 plugin-zh → 文本恢复/或明确提示需刷新”。

---

## 7. 方案做得好的地方（不是客套）

1. **先承认“浏览器半边只有一个模块”**，把“动态加载”降级为“动态挂载”，
   这个判断是对的，避免了“按需拉子模块”的死路。
2. **feature 契约 + 对称清理**的方向正确；`mount` 返回 disposer 是唯一能
   支撑开关的模型。问题在执行细节，不在模型。
3. **MVP 选 quote-reply + session-search** 覆盖了“纯客户端”和“纯宿主”两条路径，
   选得很准；比先做 6 个 UI 功能聪明。
4. **把“生死线”单独拎出来、先做最小验证**，这是方案里最专业的习惯。
   可惜它验证的假设（普通 boolean + apply 重跑）本身是错的，见 3.1。
5. **`concat-fresh` 测试**直接治“改了源码忘了构建”，这个思路很好；
   换成 esbuild 也建议保留同样的“产物与源码同步”断言。
6. **承认 plugin-zh 的 DOM 改法是技术债**，没有把它包装成“最佳实践”，诚实。
7. **archive-manager 的“假构建”判断，我实测基本成立**：
   用 `build.mjs` 从 `src/client/client.js` 重新生成，得到的 `lib/client.js`
   与仓库里逐字节相同（17546 B），`git status` 无改动。
   所以删除 `lib/` 本身风险低；但注意 `src/client/client.js` 里是
   `export function apply`，直接拷进 concat 会带 `export`，需要改造，不能“直接进”。

---

## 8. 放行条件（Definition of Done）

在进入阶段 0 编码前，请先完成 **0.5 天 spike**，并满足下面 8 条。
任何一条不满足，都不要继续写容器。

### 8.1 Spike（0.5 天，只做这一件事）

在真实 DSH 里做一个最小包 `dsh-toolbox-spike`：

1. `index.js`：`Config` 里一个 `Schema.boolean().default(true).volatile()`；
   `apply` 里按 `config.flag.get()` 注册一个假工具；
   `ctx.on('loader/volatile-update', ...)` 里 dispose/重注册。
2. `client.js`：`inject: ['slots','locale','configForms']`；
   注册 `plugins.row.config`（key = `dsh-toolbox-spike#<rowId>`），
   画一个 checkbox，写 `configForms.get(rowId).set('flag', next)`。
3. 装进 profile，打开插件页：
   - 能看到 checkbox（证明 volatile + 自定义表单路径成立）；
   - 点一下，工具**不刷新页面**消失/出现（证明 `loader/volatile-update` 成立）；
   - 关掉整个 row，再刷新，确认客户端行为（证明 6.6 的“行禁用”语义）。
4. 如果任何一步不成立，**回来改方案，不要进入阶段 0**。

### 8.2 必须修的 8 条

1. **Config**：6 个字段全部 `.volatile()`；宿主一律 `.get()`；
   客户端一律读 `configForms` 快照的普通值。
2. **设置表单**：自己实现 `plugins.row.config` 常驻表单；
   不依赖“官方自动投影”；表单不受任何开关控制。
3. **容器**：`disposed` 标志 + reconcile 串行队列 + `mounting` 占位；
   `readSwitches` 的 Promise 在 disposed 后不得 mount；
   设置缺失/失败 = off。
4. **事务化 mount**：`env.track()` 接管每个 disposer；mount 抛错自动回滚；
   每个 disposer 独立 try/catch；dispose 幂等。
5. **plugin-zh**：实现“原文 WeakMap + 条件还原”；摘 `DOMContentLoaded`；
   状态移入 feature 实例；卸载清 `window.__DSH_PLUGIN_ZH__`。
   如果决定“关闭需刷新”，必须在 UI 明说，不能假装立刻关。
6. **Storage patch**：实例 patch 优先；所有权检查；`active` 标志；
   单例守卫；不删 `BACKUP_KEY`；还原失败提示“需刷新”。
7. **拼接**：改用 esbuild（devDependency，产物提交），或至少 per-file IIFE +
   分隔符 + 查重 + HMR reset；容器 `return` 顺序写成模板并测试。
8. **迁移**：先卸载旧 6 个 bundle/row；启动自检重复工具/已 patch Storage/旧 slot；
   README 写清 `session-query-sqlite` 随 bundle 生效、desktop/web 差异、
   没有“免费官方表单”这件事。

### 8.3 建议的提交顺序

1. spike（0.5d）→ 你验收；
2. 容器 + 测试骨架（0.5d）：fake ctx、registry 测试、artifact 加载测试、泄漏计数；
3. 迁 quote-reply + session-search（1d）：先客户端、再宿主；每步跑全量；
4. 迁 draft-saver（1d）：Storage 测试矩阵先写，再改代码；
5. 迁 plugin-zh（0.5d）：还原逻辑 + 测试；
6. 迁 panel-menu + archive（1d）：archive 的 style/root/interval 清理；
7. 收尾（0.5d）：迁移文档、旧仓库归档、真实页面 E2E。

**总计 > 4.5 个工作日**，比方案估的 2.5 天多。多出来的主要是：
设置表单（方案以为是免费的）、7 组假 ctx/测试、Storage 安全矩阵、
plugin-zh 还原、迁移自检。

---

## 9. 我无法核实 / 需要你确认的点

以下不是“我断定”，而是“我只能看到快照，需要你在真实环境确认”：

1. **行级禁用（`set_plugin(false)`）后客户端模块是否仍 apply**。
   从 `dsh-client-modules` 的加载方式看，客户端模块按包级 `dsh.client` 清单加载，
   行开关只切 host entry；但我没有在你的页面上做运行时验证。
   如果仍 apply，必须把“namespace 缺失”当成 off。
2. **`configForms` 服务在你当前 web profile 是否始终可用**。
   它由 `@deepseek-ai/dsh-client-ui-settings` 提供；如果某个 profile 没装这个客户端包，
   `inject: ['configForms']` 会让整个工具箱不激活。需要按 profile 确认。
3. **`plugins.row.config` 的 key 是否就是 `包名#rowId`**。
   我读到的源码是这样（`rowConfigKey`），但你的 row id 由 patch 决定；
   如果 row id 改了，表单会消失。需要在 spike 里确认。
4. **archive-manager 的 `@deepseek-ai/dsh-workspace` 在新包安装方式下能否解析**。
   当前安装副本能解析到 harness 安装目录；换成 `plugin_manager install_bundle` 后未知。
5. **desktop profile 是否需要这些客户端功能**。
   方案只写了 web；`session-search` 目前也装在 desktop。合并后 `platform: 'web'`
   会让 desktop 没有客户端半边。需要你拍板。
6. **`loader/volatile-update` 在你的 DSH 版本上的实际触发**。
   源码里存在（`cordis-plugin-loader/lib/index.js:422`），但 alpha 版本可能变；
   spike 必须实测。
7. **旧 6 个 bundle 的实际安装状态**。
   据我读到的 `~/.dsh/profiles/web/package.json` 快照，6 个都在 `dsh.profile.bundles` 里；
   请自行核实当前状态，不要以我的读取为准（可能已被你改过）。
8. **真实浏览器里 `Storage.prototype` 的可写性 / 扩展干扰**。
   Node fake 测不出；必须在 Chrome/Edge 里跑第 4.4 节的第 12 条。

---

## 10. 最终结论

### 能不能批？

**不能按 v1 原样批。**
它不是“方向错了”，而是“把三个 DSH 机制想当然了”，
并且容器的清理模型在实现层面不闭环。

### 批什么？

- ✅ **批准方向**：一个包、一个容器、feature 注册表、按开关 mount/unmount、
  MVP 先打通 quote-reply + session-search。
- ✅ **批准 0.5 天 spike**：只验证“官方设置表单 + volatile 开关 + 宿主工具热插拔”。
- ❌ **不批准直接进入阶段 0 编码**：在 spike 通过、B1–B10 有明确修法之前，
  写出来的容器大概率是“开关能点，但关不干净”。

### 一句话给 Harness

> 你的“动态挂载”思路是对的，但你把“官方设置表单”当成了免费的，
> 把 `Config` 当成了普通 boolean，把 `mount` 当成了不会失败、
> 不会重入、不会被卸载后回调的纯函数。
> 先把这三个假设在真实 DSH 里打穿，再谈 6 个功能合并。

---

## 附录 A：关键证据索引

| 主题 | 文件 / 位置 |
|---|---|
| volatile 表单只收 volatile 字段 | `~/.npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js:122` |
| 无 volatile 字段 → entry 被跳过 | 同上 `:418` |
| 非 volatile 路径拒绝写入 | 同上 `:505` |
| volatile 变化不 restart、只 emit | `.../cordis-plugin-loader/lib/index.js:382-384, :397-422` |
| volatile 字段被包成 ref | `.../schemastery/src/index.ts:521` |
| `Config` 表单是键控 slot，不是自动的 | `.../dsh-client-ui-plugin-manager/lib/client.js:27, :57, :2818` |
| `configForms` 服务与 `inject: ['remote','remote.settings']` | `.../dsh-client-ui-settings/lib/client.js:1270, :1494` |
| slot inject/register 的 disposer 语义 | `.../dsh-client-ui-renderer/lib/client.js:1368, :1603` |
| tools register/guard/restrict/pre-execute | `.../dsh-tools/lib/index.js:2955, :2972, :2989, :3302, :3318` |
| unknown tool 是 tool error，不是崩溃 | 同上 `:2623` |
| plugin-zh 改写文本、断 observer、DOMContentLoaded | `dsh-plugins/dsh-plugin-zh/client.js:215, :318, :329, :333` |
| draft-saver patch/restore | `dsh-plugins/dsh-draft-saver/client.js:177, :266, :276, :291-296` |
| archive style/observer/interval/cleanup | `dsh-plugins/dsh-archive-manager/src/client/client.js:57, :172, :215, :252, :398, :417` |
| archive host inject 并集 | `dsh-plugins/dsh-archive-manager/src/host/index.js:36` |
| session-search 未保存 register 返回值 | `dsh-plugins/dsh-session-search/index.js:271` |
| panel-menu 的 DOM 代理选择器 | `dsh-plugins/dsh-panel-menu/client.js:81-83` |
| 旧 patch 的重复插入 | `dsh-plugins/dsh-session-search/cordis.patch.yml` |

## 附录 B：本次审查实际执行的核验

1. 读取方案全文（491 行）与 6 个插件的客户端/宿主源码。
2. 读取本机 `@deepseek-ai/dsh@0.2.1-alpha.4` 的 `dsh-settings`、
   `dsh-config-editor`、`cordis-plugin-loader`、`dsh-tools`、
   `dsh-client-ui-settings`、`dsh-client-ui-plugin-manager`、
   `dsh-client-modules`、`dsh-client-ui-renderer` 源码。
3. 用 `build.mjs` 重新生成 `dsh-archive-manager/lib/client.js`，
   与仓库文件逐字节比对：一致（17546 B），`git status` 无变化。
   → 方案“假构建”的判断基本成立；但 `src/client/client.js` 带 `export function apply`，
   不能直接拷进 concat。
4. 统计客户端源码总量约 97 KB，与方案“约 100 KB”一致。
5. 未执行：真实 DSH 页面上的开关实测、Playwright E2E、真实浏览器 Storage 身份验证
   —— 这些必须在 spike 里由你/Harness 完成。

---

> **审查官备注**：本报告只读，未修改被审代码；第 3 条核验时执行的 `build.mjs`
> 输出与仓库现有文件完全一致，未产生改动。上面所有“你的环境”描述都来自我读取时的
> 快照，请你自行复核。
