# dsh-toolbox S1 验收 · Bug 单

> 审查对象：`dsh-plugins/dsh-toolbox/`（commit `0a95350`）
> 审查方式：读源码 + 跑测试 + 在真实 Cordis 上复现
> **结论：S1 不通过。** 29 项测试是真的，但**没有一项真正激活过宿主 `apply`**，也没有覆盖设置表单和实时开关的接线。
> 修完 P0-1 / P0-2 / P0-3 后可重跑验收；P1 必须在 S2/S3 前修完。

---

## 0. 先说真实的

- `npm test`：**29 pass / 0 fail**（我实际跑了）。
- `npm run build`：与提交的 `client.js` 逐字节一致，`git status` 干净。
- `client.js`：14 KB，esbuild 0.28.2，无 `__require(`，无 `import_react`，`__ModuleLoader__.load` 的 id 正确。
- 测试不是空壳：`host-config` 用了真实 schemastery，`artifact` 在 `vm` 里执行了真产物，`scope`/`container`/`leak` 都驱动真实模块。
- 这一点要肯定：**没有用 `assert(true)` 骗人。**

但“测试真”不等于“测试够”。下面这些问题，29 项测试一个都没抓到。

---

## P0-1（阻断）宿主 `apply` 返回了普通对象，Cordis 会直接报 `Invalid effect`

**位置**：`src/host/index.js:118`

```js
// Exposed for the host config test; harmless in production.
return { read: () => readConfig(config) }
```

**为什么是阻断**：Cordis 把 `apply` 的返回值当成 effect 收集；
`cordis/lib/index.js:1142-1166` 只接受 `function`、`null/undefined`、thenable、同步/异步 iterable。
普通对象 `{ read }` 会走到最后的 `throw new TypeError("Invalid effect")`。

我用真实 Cordis 复现：

```js
import { Context } from '.../cordis/lib/index.js'
const root = new Context()
root.plugin({ apply() { return { read: 1 } } })
// => ERR Invalid effect
```

所以这个宿主插件在 DSH 里**一激活就失败**。S1 没装进 profile，所以没人发现；
`host-config.test` 只 import 了 `makeGuard`，**从未调用 `apply`**。

**修法**：删掉返回值（或返回一个真正的 disposer）。
`read` 只是测试方便，改成导出一个独立 helper，或让测试直接调 `readConfig`。
**必须补测试**：

```js
const fakeCtx = { tools: { register: () => () => {}, guard: () => () => {} },
                  effect: (fn) => fn(), on: () => () => {} }
const result = apply(fakeCtx, Config(ALL_ON))
assert.equal(result, undefined)   // 或 typeof result === 'function'
```

更稳的做法：用真实 `Context` + 一个 fake `tools` service 激活一次，断言 fiber 不失败。

---

## P0-2（阻断 S1 的“可用性”）没有设置表单，6 个开关在页面上不存在

**证据**：`grep -rn "plugins.row.config" src` → **0 条**。
`src/client/` 只有 `index.js / runtime / container / scope / registry / switches / features`，
**没有 v2 方案里的 `form.js`**。

后果：

- 宿主 `Config` 是 volatile，`configForms` 能读到值；
- 但插件管理器的行详情页 `renderSlot("plugins.row.config")` 没有注册任何 cell；
- 结果就是：**没有开关 UI**。用户只能改 YAML，不能实时开/关。
- 包描述和 README 都写着“6 个开关”，这与实际交付不符。

`artifact.test` 用了一个 fake `configForms`，所以它测的是“有表单时容器能挂”，
不是“页面上真的有表单”。

**修法**：把 Spike 里的 `SpikeCard` 搬成 `src/client/form.js`：

- 注册 `plugins.row.config`，key = `dsh-toolbox#toolbox`；
- 读值优先用 `configForms.get('toolbox')` 的 `getSnapshot().value`；
- 如果要用 `props.form`，注意它的形状是 **`{ state, mutate }`**（`ConfigPageForm`），
  **不是** `{ getSnapshot, set }`；`form.set(key,bool)` 是 controller 的 API，不是 `props.form`；
- 写值用 `configForms.get('toolbox').set(key, bool)` 或 `props.form.mutate([{op:'set',path:[key],value:bool}], revision)`。

**必须补测试**：fake `ctx.slots.inject/register` 记录调用，断言 key 精确等于
`dsh-toolbox#toolbox`，并渲染一次表单不抛错（Spike 已经踩过“组件抛错→整页空白”的坑）。

---

## P0-3（高）`watchSwitches` 不重试：`configForms` 晚到 → 开关只能开一次，之后不再实时

**位置**：`src/client/switches.js:81`、`src/client/container.js:175`

`readSwitches` 会重试 20×250ms（等 `configForms` 出现），
但 `watchSwitches` 只在 `start()` 里调用一次，`pickForm` 拿不到 form 就返回：

```js
if (!picked || !picked.form || typeof picked.form.subscribe !== 'function') return () => {}
```

如果 `configForms` 在 apply 时还没就绪（这正是 `readSwitches` 要重试的原因），
那么：

1. `readSwitches` 稍后拿到值 → 功能挂上；
2. `watchSwitches` 已经返回 no-op → **后续开关变化永远不触发 reconcile**；
3. 用户看到的是“第一次能开，之后点了没反应”。

`container.test` 全部注入 `watchSwitches: () => () => {}`，
`artifact.test` 也注入 no-op，所以这条路径完全没测。

**修法**：

- `start()` 在 `readSwitches` resolve 后再建立 watch；或
- `watchSwitches` 内部重试/晚绑定（`ctx.inject(['configForms'], ...)`），返回一个能取消重试的 disposer；
- 如果 `configForms` 在此期间始终不出现，给出可见诊断，而不是静默 no-op。

**必须补测试**：让 `ctx.get('configForms')` 前 N 次返回 undefined，之后返回 form；
然后通过 form 的 subscribe 触发一次 false，断言对应功能被卸载。

---

## P1-1 缓存写入函数从未被调用，I1 的缓存测试是“假生产路径”

**位置**：`src/client/switches.js:112` `storeSwitches` —— `grep` 全仓库，**只有定义，没有调用**。

所以生产环境 `cacheSwitches()` 永远返回 `{}`；
`container.test` 的 I1 之所以能测“reversible 从缓存启动”，
是因为它注入了 `cachedSwitches: () => ({...})` 这个假缓存。

这不是正确性阻断（缓存空 → 等真实值，仍然安全），
但这是“测了一个生产不会发生的分支”，并且 README 宣称的缓存能力是空的。

**修法**：在 `readSwitches`/`watchSwitches` 成功拿到值时调用 `storeSwitches(values)`。
**补测试**：`storeSwitches` → `cacheSwitches` 往返；第二次 container 能从缓存预挂 reversible。

---

## P1-2 宿主开关 fail-open：`isOn` 默认 true，guard 异常也放行

**位置**：`src/host/config.js:52`、`src/host/index.js:44-46`、`test/host-config.test.mjs:62-78`

```js
export function isOn(config, key, fallback = true) { ... }
```

- 如果 `config.get()` 失败，`readConfig` 返回 `{}` → `isOn` 返回 **true**；
- `sync()` 因此会注册 probe；
- `makeGuard` 的 catch 返回 `undefined`（允许），
  即配置读不出来时 `session_search` 仍然可用。

这与你们自己定的“缺值/读取失败 = 关”相反。
当前测试甚至把错误行为写成了期望：

```js
assert.equal(isOn({}, 'sessionSearch'), true)
assert.equal(broken({ name: GUARDED_TOOL }), undefined, 'a failing read must not deny')
```

**修法**：

- 运行时判断一律 `readConfig(config)[key] === true`（fail closed）；
- 或者 `isOn` 的默认 fallback 改为 `false`，只有明确要“默认开”的地方传 true；
- `makeGuard` 的 catch：因为已经先判断了 `exec.name`，对 `session_search` 应该返回 denial，
  对其它工具返回 `undefined`；不能一律放行。

**补测试**：config 读失败 → guard 对 `session_search` 返回 denial；probe 不注册。

---

## P1-3 `env.h` 是 undefined，S2 把旧 feature 搬进来会踩

**位置**：`src/client/index.js:35`

```js
env: { h: undefined, probe, host },
```

v2 的 feature 契约里 `env` 有 `h`；旧 `quote-reply`/`draft-saver` 大量用 `h`。
S1 的桩不用 `h`，所以测试全绿；S2 第一迁移就会 `env.h(...)` → TypeError。

**修法**：`import { h } from './runtime.js'` 并放进 env（`h` 是晚绑定访问器，安全）；
或者明确从契约里删掉 `h`，要求 feature 从 runtime import。
无论哪种，补一条“env.h 可调用”的测试。

---

## P1-4 `prepack` 在 Node 24 上必然失败

**位置**：`package.json:27`

```json
"prepack": "node tools/build.mjs && node --test test/"
```

你们自己的 commit 信息说 “a directory argument is not a module in node 24”，
`test` 脚本改成了 `node --test`，但 **`prepack` 没改**。
我实际跑：

```
$ node --test test/
✖ test ... fail
```

后果：`npm pack` / `npm publish` / 任何触发 prepack 的安装流程失败。
改成 `node --test` 或 `node --test test/*.test.mjs`。

---

## P1-5 `env.track` 对 fiber 只“发起”dispose，不 await、不 catch

**位置**：`src/client/scope.js:19`

```js
if (typeof value.dispose === 'function') return () => value.dispose()
```

- Cordis fiber（`ctx.inject` / `ctx.plugin` 返回）的 `dispose()` 是**异步 effect**，返回 Promise；
- `scope.dispose` 忽略返回值：不等待、不 catch；
- 如果 dispose reject → **unhandled rejection**；
- 如果用户快速 off→on，上一次 teardown 可能还在进行，新 mount 已经注册，出现双实例/服务冲突。

`scope.test` 用的是同步 fake `{ dispose: () => (disposed += 1) }`，测不出这个问题。

**修法**：至少 `Promise.resolve(result).catch(...)`；
更彻底的做法是让 `scope.dispose()` 返回 Promise，container 的队列 await 它。
**补测试**：async fiber 成功/失败各一条，断言无 unhandled rejection、状态最终 off。

---

## P1-6 双重登记：`mount` 返回 disposer + `env.track` 同一个 disposer 会执行两次

**位置**：`src/client/container.js`（`scope.track(feature.mount(...))`）与 `registry.js` 注释

registry 的注释说 “returns a disposer AND uses env.track is therefore safe”，
但代码会把同一个 disposer 存两次；`scope.dispose` 会调两次。
大多数现有 disposer 是幂等的，但这是靠运气，不是靠契约。

**修法**：`scope.track` 用 `WeakSet` 去重（函数/对象身份），或契约只允许一种形式。
**补测试**：一个非幂等 disposer 同时通过返回值 + `env.track` 登记，断言只执行一次。

---

## P2 级

1. **I2 的“重入”测试没有真正重入**
   `container.test` 在 `mount` 里调 `container.feed`，而 `feed` 只是 `schedule`（microtask 排队）；
   `mount` 先完成，之后走的是普通 unmount。`superseded` / `mounting` 分支没有被执行。
   要么加一个同步的测试钩子，要么别声称“这条测试锁住了 mount 期间翻转”。

2. **`build.mjs` 路径依赖 cwd**
   `entryPoints: ['src/client/index.js']`、`outfile: 'client.js'` 都是相对 cwd；
   从包根跑没问题，从别的目录跑 `build-fresh` 会失败。用 `import.meta.url` 解析 root / `absWorkingDir`。
   `build-fresh` 还会原地重建，失败时留下脏工作区；建议输出到临时文件再比对。

3. **`readSwitches` 的 20 个定时器不可取消**
   container dispose 后仍会跑到 5s。加一个取消标志/AbortController。

4. **死代码/误导字段**
   `storeSwitches`、`CLIENT_FEATURE_KEYS`、`defaultOn` 都没有实际使用；
   `defaultOn` 会让人以为容器有“默认值”语义，但 `wantOf` 只看 `=== true`。要么用，要么删/注释清楚。

5. **没有找到 `S1 交付.txt`**
   目录里只有 README。如果它在别处，忽略；如果要作为交付物，补进来。

---

## 验收结论

**S1 不通过。**

不是因为测试造假，而是因为：

- 宿主 `apply` 从没被真正激活过（P0-1，真实 DSH 会 `Invalid effect`）；
- 设置表单根本没实现（P0-2，页面没有开关）；
- 实时开关的 watch 在 `configForms` 晚到时是 no-op（P0-3）。

这三条修完、补上对应测试后，S1 可以重跑验收。
P1 里的 fail-open、缓存死路径、fiber 异步 dispose、prepack 建议在 S2 前一起清掉，
否则 S2 迁移旧 feature 时会把这些问题放大。

---

## 附：我这轮实际执行的命令/证据

```text
cd dsh-plugins/dsh-toolbox
npm test                                  -> 29 pass, 0 fail
node --test test/                         -> fail (prepack 用的就是这条)
npm run build                             -> ok; git status clean; client.js 未变
npx esbuild --version                     -> 0.28.2
grep "__require(" client.js               -> 0
grep "plugins.row.config" src             -> 无
grep "storeSwitches" .                    -> 只有定义
# Cordis 复现
root.plugin({ apply(){ return { read: 1 } } }) -> ERR Invalid effect
root.plugin({ apply(){ } })                    -> ok
```
