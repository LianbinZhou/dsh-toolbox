# dsh-toolbox S1 最终复核

> 审查对象：commit `32be90b`（59 tests）
> 复核时间：2026-10-17
> 结论：**核心 4 项全部通过；S1 暂不盖无条件 PASS。**
> 有 3 个 P1 必须修完（都是分钟级），修完即 PASS；S2 可以并行启动，但不要把 S1 标记为完成。

---

## 一、你点名的 4 项：通过

| # | 检查 | 结果 |
|---|---|---|
| 1 | `npm test` 是不是 59 绿 | ✅ 我实际跑了：**59 pass / 0 fail / 0 skipped**，`git status` 干净；`build-fresh` 也过了 |
| 2 | `src/host/index.js` 的 `apply` 返回值合法吗 | ✅ 已无返回值；`test/host-apply.test.mjs` 用**真实 Cordis Context** 激活，`return { read: 1 }` 会 `Invalid effect`，`apply` 正常；`registers=1, guards=1` |
| 3 | `src/client/` 有没有真的注册表单 | ✅ `src/client/form.js` + `src/client/index.js` 注册了 `plugins.row.config`，key = `dsh-toolbox#toolbox`；`artifact.test` 直接断言了 slot key，并渲染出 6 个 checkbox |
| 4 | `isOn` fail-closed / 异步 fiber catch | ✅ `isOn` 默认 `fallback=false`，`readConfig` 失败返回 `{}` → off；guard 读失败对 `session_search` 返回 DENIAL。`scope.run` 对 thenable 加了 `.catch`，`scope.dispose()` 返回 Promise，测试用 async reject 验证无 unhandled |

Spike 的坑也基本避开了：`safe` 读、组件不抛、per-key pending、乐观值、`props.form` 的 `{state,mutate}` 形状都有测试。

---

## 二、仍然存在的坑（按优先级）

### P1-1 `npm pack` 不包含 `src/`，打包安装后宿主半边会 `ERR_MODULE_NOT_FOUND`

`package.json` 的 `files` 只有：

```json
["index.js","client.js","cordis.patch.yml","README.md","LICENSE","locale/*.json","icon.svg"]
```

但根 `index.js` 是：

```js
export { ... } from './src/host/index.js'
```

`src/` 不在 `files` 里。我实际跑：

```text
npm pack --dry-run --ignore-scripts --json
=> files: LICENSE README.md client.js cordis.patch.yml icon.svg index.js locale/*.json package.json
=> src included: false
```

后果：现在用 `link:` 安装（`~/.dsh/profiles/web/package.json` 就是 link）没问题，
但一旦 `npm pack` / 发布 / 用 tarball 安装，宿主入口直接找不到 `src/host/index.js`。
**修法**：`files` 加 `"src/host/**", "src/shared/**"`（`src/client` 已被 client.js 打包，可不加；或整个 `src/` 都加）。
**验收**：`npm pack` 后在临时目录 `npm install <tgz>`，`node -e "import('dsh-toolbox')"` 能解析 `Config/apply`。

### P1-2 `host-apply.test.mjs` 依赖一个 extraneous 的 `@deepseek-ai/cordis` 软链，干净安装会失败

`test/host-apply.test.mjs` 第一行：

```js
import { Context } from '@deepseek-ai/cordis'
```

但 `package.json` / `package-lock.json` 里**没有** `@deepseek-ai/cordis`。
现在能跑，是因为：

```text
node_modules/@deepseek-ai/cordis -> C:\Users\zhou0\.npm-global\...\dsh\node_modules\@deepseek-ai\cordis
npm ls => @deepseek-ai/cordis@4.0.5-alpha.2 extraneous
```

`npm ci` 会删掉这个软链，59 项里这条会直接 fail。
**修法**：把 `@deepseek-ai/cordis` 加进 `devDependencies`（精确 `4.0.5-alpha.2`），或把这条测试改成不依赖真实 Cordis 的本地 stub。
**验收**：删 `node_modules` → `npm ci` → `npm test` 仍然 59 绿。

### P1-3 `watchSwitches` 的重试没有上限，`configForms` 永远不出现时每 150ms 轮询到天荒地老

`src/client/switches.js`：

```js
const bind = () => {
  ...
  if (!picked || typeof picked.form.subscribe !== 'function') {
    timer = setTimeout(bind, RETRY_MS)   // 没有 MAX_RETRIES
    return
  }
  ...
}
```

`readSwitches` 有 `MAX_RETRIES=40`，`watchSwitches` 没有。
如果某个 profile/壳没有 `configForms`，这个定时器会一直活着，直到插件卸载；
这不是“晚绑定成功”，是静默的 6.7 次/秒轮询。
**修法**：加上限（比如 40 次）并在超限后 `console.warn` + 停止；或改成退避（150→500→2000ms）。
**验收**：`makeCtx` 永远不返回 `configForms`，等待超过上限后断言不再有 timer（可用 fake `setTimeout` 计数）。

---

## 三、P2（不阻断 S2 启动，但 S3/S5 前清掉）

1. **scope 对 fiber 的去重不完整**
   `toDisposer({dispose})` 每次都返回**新的** `() => value.dispose()` 包装；
   `seen` WeakSet 按包装函数去重，所以“同一个 fiber 既 `env.track` 又 return”仍会 dispose 两次。
   Cordis fiber 的 dispose 目前幂等，所以没炸；但 P1-6 的“same disposer runs once”只对函数成立。
   建议用 `WeakMap<value, wrapper>` 保证同一对象只包一次，并补 fiber 双登记测试。

2. **`scope.dispose()` 里同步抛错会丢掉 async 的等待**
   一个同步 disposer 抛错时，函数在 `return Promise.all(pending)` 之前就 throw；
   已经启动的异步 disposer 虽然被 `.catch` 了，但调用方拿不到那个 Promise。
   建议始终返回 `Promise.all(pending).then(() => { if (first) throw first })`，测试改成 `assert.rejects`。

3. **`client/index.js` 的 cleanup 没有把 `container.dispose()` 的 Promise 交回给 Cordis**
   ```js
   return ctx.effect(() => () => {
     ...
     Promise.resolve(container.dispose()).catch(...)  // 没有 return
   })
   ```
   异步 scope 的 teardown 不会被 fiber 等待。HMR/快速卸载时可能与下一次 mount 交叠。
   建议 `return Promise.resolve(container.dispose()).catch(...)`。

4. **container 的 reconcile 队列会等 `flushDisposals()`**
   一个“永不 settle”的 fiber disposer 会把后续所有开关 reconcile 卡住。
   建议给 disposal 加超时（例如 2s）或把 disposal 从 reconcile 队列里拆出去，别让它阻塞 toggle。

5. **表单读、写源不一致**
   `form.js` 的 `valuesFromPropsForm` 优先 `props.form`，但 `writeSwitch` 优先 `configForms.get('toolbox')`。
   当前 row id 都是 `toolbox`，两者指向同一个；但一旦 row id/entry id 变化，就会“显示 A 的值、写到 B”。
   建议写入也优先 `props.form.mutate`，或明确只用 `configForms` 并在 UI 显示 entry id。

6. **表单文案没走 `ctx.locale`**
   `SWITCHES` 的 label/hint 是写死中文；官方 `ui-plugin.md` 要求可见文案走 Client locale。
   个人自用可接受，但和“6 个开关”一起发布时，英文界面会中英混排。S2 收尾时处理。

7. **`installRuntime` 没有“已安装且不是同一份 React”的守卫**
   HMR/双副本时静默替换；同一 loader 的 React 没问题，但加一行“不同实例则 warn/拒绝”更稳。

8. **`host apply` 的 `sync` 没有包 `registerProbe` 的 try/catch**
   S1 的 probe 名字唯一；S2 换成 `session_search` 后，如果旧 bundle 还在，`tools.register` 同名可能抛错，整个 host effect 失败。
   迁移自检/重复注册拒绝应该在这里落地。

---

## 四、结论

- **核心 4 项：PASS。**
- **S1 发布完整性：不 PASS**，因为 P1-1（`files` 缺 `src`）和 P1-2（cordis extraneous）会让“打包/干净安装”失败；
  P1-3 是真运行时轮询泄漏。
- **建议：S2 可以并行启动**（容器/表单/宿主路径已经真机验证），
  但 S1 的 PASS 章要等这 3 个 P1 修完；预计 10–20 分钟。
- 修完后我会只看三点：`npm pack` 安装后 host 能 import、删 `node_modules` 后 `npm ci && npm test` 仍 59 绿、`watchSwitches` 无上限轮询消失。三点过，直接盖章。
