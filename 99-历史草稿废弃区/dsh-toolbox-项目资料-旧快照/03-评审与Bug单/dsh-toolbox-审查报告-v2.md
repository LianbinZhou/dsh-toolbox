# dsh-toolbox 方案 v2 · 二次审查（快审）

> 审查对象：`dsh-toolbox-技术方案-v2.md`
> 对照：第一轮审查报告 8.2 / DSH `0.2.1-alpha.4` / Spike 包 `dsh-toolbox-spike`
> 结论：**不点头。最多批 S1 作为纠错阶段；S2–S6 暂停，等 3 个 P0 修完。**

---

## 1. 一句话结论

v2 **确实认真改了**，S1 测试骨架的方向也对；
但它把“Spike 跑通”当成了“方案闭环”，而 Spike 只验证了**字段级/根级 volatile 的事件路径**，
没有验证 v2 正文里的读法、esbuild 的 React 接线、以及缓存先行与“不可逆功能等真实值”的冲突。

按现在这份 v2 直接开 S1–S6，最可能出现的结局是：

- S1 单测全绿；
- S2 装进真实页面，工具开关能点，但 `session_search` 的 guard 一调用就 TypeError，**所有工具一起报错**；
- 或者客户端 `client.js` 里 React 变成第二份 / 顶层 `require` 直接抛，**整个工具箱不加载**。

所以不能点头。

---

## 2. 8.2 八条：真修了没有？

| 8.2 | v2 状态 | 判定 |
|---|---|---|
| 1. Config 全 `.volatile()`、宿主 `.get()`、客户端读普通值 | 正文改成“**整对象**一个 `.volatile()`”，但 4.3 的 guard 仍写 `config.sessionSearch.get()` | **❌ 逻辑仍错**。根级 volatile 下 `config.sessionSearch` 是 `undefined` |
| 2. 自己写常驻 `plugins.row.config` 表单 | Spike 已实测；v2 3.4 有方案 | ✅ 基本落实；但 `props.form` 的用法写错（见 3.1） |
| 3. `disposed` + 串行队列 + `mounting` 占位 + 缺值=关 | 代码有了 | ⚠️ **半修**：`reversible` 声明了但容器没用；缓存先挂载；mount 完成会覆盖“mount 期间被关掉”的状态 |
| 4. `env.track` 事务化 mount | `scope.js` 有了 | ⚠️ **契约自相矛盾**：3.1 写 `mount -> disposer`，3.3 却忽略返回值；只认 `env.track` |
| 5. plugin-zh 原文还原 + 摘 DOMContentLoaded + 实例状态 | 第 6 节写了 | ✅ 方向对；但测试写“还原 / 或提示需刷新”，**“或”等于没定** |
| 6. Storage 实例 patch + 所有权 + active + 单例 | 第 6 节写了 | ⚠️ 实现方向对；**测试矩阵只写了“身份还原”一项，远不够** |
| 7. esbuild（devDependency，产物提交） | 换了 | ❌ **新阻断**：没有 `__ModuleLoader__.load` 接线；没有 React external/运行时桥；要么顶层 `__require("react")` 抛错，要么打包第二份 React |
| 8. 迁移前置：卸旧 6 个 + 自检 | 第 7 节写了 4 步 | ⚠️ 少了“旧客户端模块/行禁用/Spike 自身清理”；`set_bundle(false)` 是否移除 patch 未验 |

**结论：8 条里 3 条仍是错的（1/7 + 4 的契约），3 条是半修（3/6/8）。**

---

## 3. 新引入的风险

### 3.1 根对象 `.volatile()`：正文读法必崩

我用本机 schemastery 实测：

```js
const root = Schema.object({ a: Schema.boolean().default(true) }).volatile()
const v = root(undefined)
v.a            // undefined
v.get()        // { a: true }
```

所以 v2 4.3 的

```js
config.sessionSearch.get()
```

在“整对象 volatile”下是 `undefined.get()` → **抛 TypeError**。

后果分两种：

- 如果这段在 `apply` 里：宿主插件激活失败，6 个宿主功能全不挂；
- 如果这段只在 `tools.guard` 里：**每次工具调用** guard 都抛，`prepareExecution` 的 catch 会把它变成该次调用的 tool error → 所有工具都“报错”，agent 像瘸了一样。

**修法（二选一，不要混）**：

- A. 整对象 volatile：所有地方 `config.get().sessionSearch`，**每次判断都重新 get**，不要 `const {sessionSearch} = config.get()` 缓存；
- B. 字段级 volatile（第一轮报告建议）：`Schema.boolean().default(true).volatile()`，`config.sessionSearch.get()`。

Spike 的 `readConfig(config)` 已经兼容两种；v2 正文没有沿用，反而写死了字段级读法。
**这是“假装修了”的第一处。**

### 3.2 esbuild：React 接线没写，构建大概率不可用

v2 的 `build.mjs`：

```js
entryPoints: ['src/client/index.js'],
bundle: true,
format: 'iife',
// 没有 external、没有 loader wrapper、没有 React 运行时桥
```

三种可能，全是坑：

1. **不加 `external: ['react']`**：esbuild 会从磁盘解析 `react`。
   如果 devDependencies 装了 React → **打包第二份 React**，hooks/context/slot 全乱；
   如果没装 → build 直接失败。
2. **加 `external: ['react']`**：esbuild 在 **IIFE 顶层**生成
   `var import_react = __toESM(__require("react"))`；
   顶层的 `__require` 在 DSH 页面里没有 `require` → 抛
   `Dynamic require of "react" is not supported`。
3. **不写 `window.__ModuleLoader__.load({id, factory})`**：
   3.3 的入口是 `export default { inject, apply }`，esbuild 出来只是一个 IIFE，
   没有任何模块注册 → DSH 根本不会加载这个客户端。
   （Spike 的 `client.js` 是手写 `window.__ModuleLoader__.load(...)`，不是 esbuild 产物。）

**可行写法**：加一个 `src/client/runtime.js`，把 React 作为**可变运行时**注入：

```js
// runtime.js
let React
export function installRuntime(r) { React = r }
export const h = (...a) => React.createElement(...a)
export const useState = (...a) => React.useState(...a)
// ...

// index.js
window.__ModuleLoader__.load({
  id: 'dsh-toolbox',
  factory(require) {
    installRuntime(require('react'))   // 只在这里 require，esbuild 会保留局部参数
    return { inject: ['slots', 'locale'], apply }
  },
})
```

feature 文件只 `import { h, useState } from '../runtime.js'`，**不 import react**。
这样 esbuild 不会顶层 require，也不会打包第二份 React。

另外：

- `build-fresh` 的逐字节比较要求 **esbuild 版本锁定**（`0.28.2` 精确版本 + lockfile）；
  `^0.28` 在不同机器上可能产出不同字节。
- `legalComments: 'none'` 如果将来 bundle 了任何第三方代码，会剥掉许可证头；目前全是自研可接受，但要写进规则。

### 3.3 缓存先行 + “不可逆功能等真实值”自相矛盾

3.3 的容器：

```js
schedule(cachedSwitches())                 // 先用缓存挂
readSwitches(ctx).then(v => schedule(v))   // 真实值到了再对齐
```

第 3.1 节又说 `reversible:false` 的功能“不得在拿到真实开关值之前挂载”。
但**容器代码里没有用 `f.reversible`**，也没有 `settingsReady` 门闩。
结果：

- 缓存里 `pluginZh:true`，真实值是 false → 启动先汉化一遍，再还原；
- 缓存里 `draftSaver:true`，真实值是 false → 先 patch Storage，再 restore；
- 如果用户刚在另一台设备/另一个 tab 关了这些功能，这次启动仍会短暂打开。

“短暂”不是零风险：`plugin-zh` 还原逻辑一旦有 bug，就是不可逆的；
`draft-saver` 在窗口期可能写入备份/弹提示。**这正是 8.2-3 要禁止的。**

**修法**：

- `reversible:false` 的功能只在 `settingsReady === true` 后挂；
- 缓存只用于 `reversible:true` 的功能；或缓存必须带 `version + profile + rowId`，并在 `configForms` 确认 namespace 存在后才用；
- `readSwitches` 失败 → `settingsReady=true` 且全部 off（不是用缓存）。

### 3.4 `mount` 期间被关掉：`mounting` 占位救不了

3.3 在 mount 前写 `state='mounting'`，挡住了“双挂”；但如果 mount 内部同步触发一次“关掉”的 reconcile：

1. 外层 mount 还没返回，`scopes.set` 还没执行；
2. 嵌套 reconcile 看到 `phase='mounting'`、`want=false`，
   `scopes.get()` 是 `undefined` → dispose 不了，状态置 `off`；
3. 外层 mount 返回后**无条件** `state.set('mounted')` + `scopes.set(scope)`；
4. 功能在“已关”之后又被复活，且 scope 里已经挂了副作用。

**修法**：mount 返回后做一次 generation / want 复核：

```js
const gen = ++generation.get(f.id)
f.mount(...)
if (disposed || !wantNow(f) || generation.get(f.id) !== gen) {
  scope.dispose()
  state.set(f.id, 'off')
} else { ... }
```

S1 的 `container.test` 需要加“mount 期间重入且 want=false”这一条，否则测试骨架会漏。

### 3.5 3.1 契约与 3.3 代码互相矛盾

3.1：`CONTRACT = 'mount(ctx, env) -> disposer'`
3.3：`f.mount(ctx, env(ctx, scope))` —— **返回值直接丢掉**。

如果某个 feature 按契约返回 disposer、却没有把每个副作用 `env.track`，
它的 disposer **永远不会被调用**；scope 里什么都没有，toggle off 时“干净地关掉”是假的。

**修法**：二选一，并写进测试：

- 契约改成 `mount(ctx, env) -> void`，所有副作用必须 `env.track`；
- 或者 `scope.track(f.mount(ctx, env))`，把返回值也登记。

不能既说返回 disposer，又忽略它。

---

## 4. 清理债务与前置条件

### 4.1 第 6 节：方向对，但“draft-saver 测试矩阵”不够

第 6 节把第一轮报告的清理项抄得很全，这一点值得肯定。
但 `draft-saver.test.mjs` 只写了：

> 迁移原 40 项 + **dispose 后 `localStorage.setItem` 身份还原**

这只能证明“单实例、无第三方 patch、无冻结、无 sessionStorage”时能还原。
第一轮报告 4.4 的 14 条里，至少下面 7 条**必须补**，否则“绝对安全”是空话：

1. 第三方在 toolbox 之后 patch → dispose 不得覆盖第三方；
2. 双挂 A/B + 交叉 dispose → 最终只剩原始函数，不能留 wrapper 链；
3. `sessionStorage` 不被拦截/不写 `BACKUP_KEY`（fake 用两个同原型实例即可）；
4. `Object.freeze(Storage.prototype)` / non-writable → 不崩溃、明确提示“需刷新”；
5. dispose 后旧引用（mount 前缓存的 `setItem`）退化为透明转发，不再写备份/弹提示；
6. `BACKUP_KEY` 在 dispose 后仍在，下一次 mount 能恢复；
7. 真实 Chrome/Edge 里断言 `localStorage.setItem === 原始函数`（Node fake 测不出浏览器行为）。

另外，“只 patch `localStorage` 实例”在浏览器里是可行的，但 **Node 的 fake class 原型会掩盖“实例自有属性 vs 原型属性”的差异**；这条必须用真实浏览器验，不能只靠 `FakeStorage`。

### 4.2 第 7 节：迁移步骤不够“防呆”

第 7 节有 4 步，方向对，但还缺：

- **旧客户端模块**：`set_bundle(false)` 是否会让旧 `client.js` 停止 apply？
  第一轮 6.6 已经指出“行级禁用不一定停客户端”；旧 bundle 同理，必须实测。
- **行禁用语义**：v2 第 9 节自己也把“行 `set_plugin(false)` 客户端是否仍 apply”列为未知；
  但第 7 节的迁移步骤没有等这个答案就往下走。若仍 apply，旧 quote-reply/draft-saver
  可能与新工具箱**同时活着**，双浮层/双 patch。
- **Spike 自身**：`dsh-toolbox-spike` 现在还装着、`flag:true`，
  `toolbox_spike_ping` 会一直在工具表里。S1 开始前应卸掉，或至少确认它不影响计数。
- **patch 层清理**：`set_bundle(false)` 不等于从 `profiles/*/cordis.patch.yml` 删 override；
  旧 `session-query-sqlite` 那行可能还在。第 7 节第 2 步说要清，但没有给出“怎么判断清干净了”的断言。
- **启动自检的失败策略**：发现同名工具/已 patch Storage，是“拒绝注册自己”还是“报错并停用整个工具箱”？
  前者会让用户以为开关坏了；后者会让一个旧插件拖死全部。需要明确。

### 4.3 plugin-zh 的“或提示需刷新”不能算完成

第 6 节写“dispose 后文本还原 / **或明确提示需刷新**”。
如果选后者，那这个开关就不是“立刻关闭”，验收标准必须改成“关闭后提示刷新，刷新后英文”，
并且**不能**在默认挂载窗口里先汉化一遍（否则用户没点任何东西就被改了）。

---

## 5. 三个未知点：验法与兜底靠不靠谱？

| # | v2 验法 | 评价 | 兜底 |
|---|---|---|---|
| 1 esbuild 安装 | “装 + 构建 hello 包” | ✅ 验法对；但“退回 per-feature IIFE”本身仍是报告 5.1 的坑，且**没解决 React 接线** | ❌ 兜底不合格。应改为：锁定 esbuild 版本 + 提交产物；若 CI 不能装，使用仓库内已提交的构建产物（不在用户机器上构建），而不是退回手写 IIFE |
| 2 `ctx.inject` 签名 | “查 practices + 最小实测” | ✅ 签名已存在（`cordis/lib/index.js:1600` `inject(inject, callback)`）；但要注意它返回的是 **fiber**，关功能时 `fiber.dispose()`，不是普通 disposer | ❌ “退回模块级 inject 并集”正是报告 6.1 明确否定的方案。兜底应改为“模块级只留最小集 + `ctx.get()` 降级 + 该功能单独停用”，不能回到并集 |
| 3 行禁用行为 | “禁用 spike 行 + 刷新，看表单还在不在” | ⚠️ 测法太弱：行禁用后表单本来就可能不可见；应看 `window.__DSH_TOOLBOX__` 的 mounted 列表 / 控制台 apply 日志 / `configForms` namespace 是否消失 | ⚠️ “namespace 不存在 = 全 off”方向对，但与 3.3 的 `cachedSwitches()` 先行**冲突**；必须在缓存之前判断，或缓存只用于 reversible 功能 |

补充：未知 #1 的“esbuild 要装进 profile 的依赖链”这个说法本身不准确。
esbuild 是 **devDependency**，只在开发/构建机器上需要；profile 运行时只需要提交好的 `client.js`。
真正要验的是：构建机能否装（Windows 二进制、`.npmrc allow-scripts`），以及产物是否可复现。
本机 `mach-quote-tool/node_modules` 里已有 esbuild 0.28.2，但那不能作为发布方案。

---

## 6. 关于 Spike 的 63 → 62 → 64

这是 v2 最需要解释的数据，不是成功证据：

- 13:28 基线 63（含 `toolbox_spike_ping`）；
- 关掉 → 62（-1，符合预期）；
- 再打开 → **64（+2）**，不是 63。

可能是：

- 另一个插件/会话在这个窗口里加了一个工具；
- spike 的 `sync` 重注册时旧 disposer 没生效，出现了两个工具；
- 工具表里本来就有随会话变化的动态工具（如 PTC/`run_code` 相关）。

**不能用“数量”证明闭环，必须 diff 工具名集合。**
建议的验收：

```text
toggle off → names_off
toggle on  → names_on
assert names_on == names_baseline   // 集合相等，不是数量相等
重复 3 轮，最终集合不变
```

如果 `names_on` 比 baseline 多一个，说明有泄漏/重复注册，必须先查清再进 S1。

---

## 7. S1 测试骨架：够不够帮它避坑？

**不够。骨架结构很好，但缺了“会咬人”的四类测试。**

现有 S1 覆盖：scope 回滚、disposed、队列、重入双挂、缺值、泄漏计数、artifact 6 个 feature、build-fresh。
这些能防住第一轮报告里的大部分容器 bug。

但 **v2 新引入的三个 P0，S1 一个都抓不到**：

1. **根级 volatile 读法**：`container.test` 用 fake `next` 对象，不会碰 `config.sessionSearch.get()`；
   需要一条**宿主**测试：用真实 `Schema.object(...).volatile()` 调 `apply`，翻转后调用 guard，
   断言不抛且只 deny `session_search`。
2. **esbuild/React/loader**：`artifact.test` 只断言 `features.length===6`；
   需要在 fake `window.__ModuleLoader__` 里**真正执行 factory**，断言：
   - `load` 被调用且 `id === 'dsh-toolbox'`；
   - factory 执行后能拿到 6 个 feature；
   - 没有第二份 React（例如 `require('react')` 只被调用一次，或 runtime 注入的 React 与 seed 相同）；
   - 顶层没有 `__require("react")`（用 `vm` 执行即可发现）。
3. **缓存先行 + 不可逆功能**：加 `container.test`：
   - 缓存 `{pluginZh:true}`，真实值 `{pluginZh:false}` → `pluginZh.mount` **调用次数 0**（或在 `settingsReady` 前 0）；
   - `readSwitches` reject + 缓存 on → 不可逆功能不挂；
   - mount 期间 want 变 false → mount 完成后立刻 dispose，最终 off。

再加两条低成本高收益的：

4. **契约一致性**：一个按 `mount -> disposer` 写的假 feature（不用 `env.track`），
   toggle off 后断言 disposer 被调用；否则说明 3.1/3.3 的矛盾没修。
5. **`props.form` 形状**：用真实的 `{ state, mutate }` 形状渲染表单，断言不调用 `.getSnapshot()`/`.set()`；
   同时覆盖 `configForms` 晚到（apply 时 undefined）的重试路径。
   现在 3.4 的“props.form 优先 + form.getSnapshot()”在真实页面里会走不通；
   需要按 `ConfigPageForm` 的 `{state, mutate}` 或干脆只用 `configForms`。

**一句话**：S1 骨架能防“容器写错”，防不了“配置模型/esbuild/表单 API 理解错”。
而后者恰恰是 v2 最可能翻车的地方。

---

## 8. 放行条件（给老板的一页纸）

### 现在不能批（S1–S6 整体）

先修 3 个 P0，再批 S1；S1 过了再批 S2–S6。

**P0-1：统一 Config 形状**

- 选 A（整对象 volatile）→ 所有宿主读法改 `config.get().field`，4.3 必须改；
- 或选 B（字段级 volatile）→ 保留 `config.field.get()`，删掉“整对象”说法；
- 加一条真实 schemastery 的宿主测试，确保 guard 不抛。

**P0-2：esbuild 接线**

- 加 `src/client/runtime.js` 运行时桥 + `window.__ModuleLoader__.load` 入口；
- feature 不直接 `import react`；
- 锁定 esbuild 版本，`artifact.test` 真正执行 factory，断言无第二份 React / 无顶层 `__require`。

**P0-3：容器语义**

- `reversible:false` 必须等 `settingsReady`；缓存只用于 reversible；
- mount 完成做 want/generation 复核；
- 解决 `mount -> disposer` 与 `env.track` 的契约矛盾；
- 补 S1 的三条测试（根 volatile、缓存+不可逆、mount 期间关掉）。

### P1（不阻断 S1，但 S3/S5 前必须做）

- `draft-saver` 测试补齐第 4.1 节的 7 条（尤其第三方 patch、双挂、sessionStorage、真实浏览器）；
- plugin-zh 明确选“还原”还是“需刷新”，不能写“或”；
- 迁移步骤加“旧客户端模块/行禁用/Spike 清理”的验证；
- `prepare` 脚本改成 `prepack`/`prepublishOnly`（`prepare` 在安装时无 devDeps 会失败）；
- 解释 63→64；用工具名集合验收；
- `props.form` 按 `ConfigPageForm` 的 `{state, mutate}` 处理，或只用 `configForms`。

### 最终建议

**批 S1（0.5 天）可以，但 S1 的交付物必须包含上面 P0-1/P0-2/P0-3 的红灯测试；
S1 结束时再复审一次，才允许进 S2。**

如果老板要的是“今天点头、它直接写 S1–S6”，
**我的回答是：不行。现在点头，等于让它带着两个“一跑就崩”的接线错误去写 4.5 天的代码。**

---

## 9. 证据索引（本轮新增）

| 结论 | 证据 |
|---|---|
| 根级 volatile 下 `config.field` 是 undefined | 本机 schemastery 实测：`root(undefined).a === undefined`；`.get()` 才是 `{a:true}` |
| `props.form` 是 `{state, mutate}`，不是 controller | `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:203`；`dsh-client-ui-plugin-manager/lib/client.js:3835` |
| esbuild external 会在顶层生成 `__require("react")` | 本机 esbuild 0.28.2 构建输出（`var import_react = __toESM(__require("react"))`） |
| Spike 用的是根对象 volatile + `readConfig` 兼容读法 | `dsh-plugins/dsh-toolbox-spike/index.js` |
| Spike 仍安装且 `flag:true` | `~/.dsh/profiles/web/package.json:20`；`cordis.patch.yml` |
| `ctx.inject` 返回 fiber | `cordis/lib/index.js:1600` |
| `set_plugin` 行禁用与客户端模块的关系未验 | 第一轮报告 6.6；v2 第 9 节未知 #3 |
