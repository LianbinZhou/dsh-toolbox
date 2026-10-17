# dsh-toolbox

把作者自建的几个 DSH 小插件收进**一个容器**：插件页只有一行，进去有 6 个开关，每个开关实时生效。

> **状态：S1（骨架 + 纠错阶段）。**
> 容器、事务化 scope、六个功能的契约与测试已就位；真实功能体在 S2–S5 从 `dsh-plugins/*` 迁移进来。
> S1 边界：本包**尚未安装**到任何 profile。安装发生在 S2（那时才有可用的功能，而不是一个探针工具）。

---

## 这一版修了三个 P0（来自 v2 二次审查）

### P0-1 Config 形状：整对象 `.volatile()`

`schema.volatile()` 作用在**整个对象**上（与官方 `dsh-client-auto-continue` 同款）。实测后果：

```js
const Config = Shape.volatile()
config.get()                 // { sessionSearch: true, ... }   值在这
config.sessionSearch         // undefined                      不是 boolean
config.sessionSearch.get()   // TypeError                      这就是被审出来的 bug
```

所以所有读法都走 `readConfig` / `isOn`（`src/host/config.js`），**禁止解构缓存**：
root volatile 是原地更新的，`const { sessionSearch } = config` 会把 `undefined` 冻住。

`tools.guard` 里额外两层兜底：先判 `exec.name`（只 deny 自己那个工具），再整体 `try/catch`
（guard 抛错会变成**每次工具调用**的 tool error）。

### P0-2 esbuild 接线：运行时桥 + loader 入口

- 没有任何文件 `import react`；React 由 `index.js` 的 factory 从 loader 取一次，交给 `installRuntime`。
- factory 的参数取名 `load` 而不是 `require` —— esbuild 会把语法上的 `require("react")` 改写成自己的
  `__require` 垫片，在浏览器里抛 `Dynamic require of "react" is not supported`。
- 入口必须是 `window.__ModuleLoader__.load({ id, factory })`，否则宿主根本不会加载这个模块。
- esbuild **精确锁定 0.28.2**（`build-fresh` 做逐字节比对，caret 范围在不同机器上可能产出不同字节）。

### P0-3 容器语义

三条不变式，每条都有会失败的测试：

| # | 不变式 |
|---|---|
| I1 | `reversible:false` 的功能**只在真实开关值到达后**才挂；缓存只喂 reversible 的；读失败 = 全关，不是拿缓存猜 |
| I2 | `mount` 期间开关被关掉 → `mount` 返回后复核 `want`/`disposed`/代际计数，不一致就回滚并置 `off` |
| I3 | `mount` 的返回值（disposer 或 fiber）与 `env.track(...)` **都**登记，没有无主副作用 |

---

## 目录

```
dsh-toolbox/
├── client.js                 # 产物（esbuild 生成，已提交）
├── index.js                  # 包根宿主导出（Config / apply / inject / name）
├── cordis.patch.yml          # 插一行，6 个 volatile 开关
├── tools/build.mjs           # esbuild 构建
├── src/
│   ├── client/
│   │   ├── index.js          # loader 入口 + apply
│   │   ├── runtime.js        # React 运行时桥（晚绑定）
│   │   ├── container.js      # I1/I2/I3
│   │   ├── scope.js          # 事务化 disposer 账本
│   │   ├── registry.js       # 功能契约校验
│   │   ├── switches.js       # configForms 读取 + 带标签的本地缓存
│   │   └── features.js       # 5 个客户端功能（S1 桩）
│   └── host/
│       ├── config.js         # root volatile + readConfig/isOn
│       └── index.js          # apply + guard
└── test/                     # 29 项，全绿
```

客户端功能 5 个（`quote-reply` / `panel-menu` / `draft-saver` / `archive-panel` / `plugin-zh`）；
`session-search` 是**纯宿主**功能，不在客户端清单里 —— 所以"6 个开关、5 个客户端功能"不是笔误。

## 构建与测试

```sh
npm install          # 只装 esbuild（devDependency，精确 0.28.2）
npm run build        # src/client/index.js -> client.js
npm test             # 29 项：artifact / container / scope / host-config / leak / build-fresh
```

`npm test` **故意不预先构建**：`build-fresh` 先读已提交的 `client.js`，再原地重建并逐字节比对，
专门用来抓"改了源码忘了 build"。

## 已知边界（S1 阶段）

- `src/client/features.js` 里 5 个功能都是**桩**：只注册一个可撤销的监听，用来证明挂载/卸载正确。
- `src/client/switches.js` 的缓存键带 `package + rowId` 标签，防止别的行/旧版本的值被回放；
  但"缓存只用于 reversible 功能"这条**在容器里**执行，不在缓存里。
- `plugin-zh` 必须走路 B（DOM + 完整还原）：路 A（官方 locale 注入）已判死 ——
  `resolveText` 对字符串原样返回，而没有 `locale/` 的包序列化出来就是字符串；
  且 `dsh-app-boot` 里 `ctx.locale` 出现 0 次，解析全在 boot 阶段。
- 迁移（S2–S5）前必须卸载旧 6 个 bundle，并做启动自检（同名工具 / 已 patch 的 Storage / 旧 slot id）。

## 许可

MIT
