# dsh-toolbox

把作者自建的几个 DSH 小插件收进**一个容器**：插件页只有一行，进去有 7 个开关，每个开关实时生效。

> **状态：S6 完成（宿主防腐层 + 同步修复），已安装并在真机上验证。版本 v0.7.0。**
> **7 个开关全部是真功能**：会话搜索（`sessionSearch`）/ 划词引用（`quoteReply`）/
> 草稿保险箱（`draftSaver`）/ 面板收纳（`panelMenu`）/ 历史归档（`archivePanel`）/
> 归档 HTTP 接口（`archiveHttpApi`，**默认关闭**）/ 插件说明汉化（`pluginZh`）。
>
> **S5 做完了什么**：① 官方服务兼容防腐层（`src/client/dsh-adapter.js`，缺服务只降级不白屏，
> `window.__DSH_TOOLBOX__.selfCheck()` 可查）；② 新功能接入规范（`docs/S5-新功能接入规范.md`）；
> ③ 插件汉化从独立插件 `dsh-plugin-zh` **迁入容器并可逆**（开 → 中文，关 → 英文原样回来），
> 旧插件已从 web profile 彻底卸载（含 pnpm-lock）。细节见 `docs/S5-第二步最终简报.md`。
>
> **历史归档（S4）**：侧栏「历史归档」面板内含「归档 / 回收箱」两个页签。删除**先移入回收箱**
> （默认保留 **7 天**，可配 3/7/14/30/60），彻底删除需二次确认；恢复按删除前的快照放回**原工作区与原位置**。
> 真机验收五条链路全通（删除→入箱→恢复 / 彻底删除、历史归档页恢复），细节见 `docs/S4-封板简报.md`。
> 旧包 `session_search`、`dsh-quote-reply`、`dsh-draft-saver` 已从 web profile 移除（仓库保留）。

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
│   │   ├── features.js       # 5 个客户端功能的注册表
│   │   └── features/
│   │       ├── quote-reply.js    # 真功能 S2：划词引用（组件原样搬入）
│   │       ├── draft-guard.js    # 真功能 S3：草稿存储守卫
│   │       ├── draft-notice.js   # 真功能 S3：恢复提示条
│   │       └── draft-saver.js    # 把上面两者装成"草稿保险箱"
│   └── host/
│       ├── config.js         # root volatile + readConfig/isOn
│       ├── index.js          # apply + guard
│       └── features/session-search.js  # 真功能 S2：session_search 工具
├── tools/
│   ├── build.mjs             # esbuild 构建
│   └── prove-red.mjs         # 把存储矩阵跑在旧实现上，证明测试真的咬人
└── test/                     # 448 项，全绿
```

客户端功能 5 个（`quote-reply` / `panel-menu` / `draft-saver` / `archive-panel` / `plugin-zh`）；
`session-search` 是**纯宿主**功能，不在客户端清单里 —— 所以"6 个开关、5 个客户端功能"不是笔误。

## 七个开关的真实状态

| 开关 | 状态 | 功能体 |
|---|---|---|
| 会话搜索（宿主工具） | **真**（S2） | `session_search` 工具 + 接管 `session-query-sqlite` 的全文索引 seam |
| 划词引用 | **真**（S2） | 划选一段 → 浮层「引用 / 复制」 |
| 草稿保险箱 | **真**（S3） | 草稿存储守卫 + 恢复提示条 `[复制][清空][知道了]` |
| 面板收纳 | **真**（S4） | 把侧栏的面板入口收进一个「全部面板」菜单 |
| 历史归档 | **真**（S4） | 列出归档会话 + 回收箱二级页签（恢复 / 彻底删除） |
| 归档 HTTP 接口 | **真**（S4，**默认关闭**） | 7 条令牌保护的本机路由；打开才可用 |
| 插件说明汉化 | **真**（S5） | 把插件管理页的英文简介换成中文，**可逆**：关掉按钮英文原样回来（字典 28 条，从独立插件 `dsh-plugin-zh` 迁入） |

## 构建与测试

```sh
npm install
npm run build              # src/client/index.js -> client.js
npm test                   # 448 项，0 跳过（含 4 条真实 Chromium 用例）
node tools/prove-red.mjs   # 把同一套存储矩阵跑在旧实现上：应报 14 红
```

`npm test` **故意不预先构建**：`build-fresh` 先读已提交的 `client.js`，再原地重建并逐字节比对，
专门用来抓"改了源码忘了 build"。

**真实浏览器测试需要 Playwright，已经锁进 `devDependencies`（1.64.1，精确版本）。**

`npm ci` 会装 Playwright 包，但**浏览器二进制不在 npm 包里**，第一次要单独装一次（约 120 MB，需走代理）：

```sh
npx playwright install chromium   # 只跑一次，之后缓存复用
```

这些测试**没环境时会报错而不是跳过**——这是故意的：我们要的是 `448 / 448，0 skipped`，
而不是"没环境就跳过"的假绿。

`prove-red` 是测试的**反向证据**：它把同一套矩阵跑在 `test/fixtures/legacy-guard.mjs`（S3 之前那份 patch
`Storage.prototype` 的实现）上，正常应有一片红。**如果哪天它全绿了，说明矩阵不再咬人**，工具会以退出码 1 报警。

## 草稿守卫（S3）的安全模型

八条约束，逐条有测试：

1. 只 patch `localStorage` **实例**；`Storage.prototype` 绝不碰（原型是 `sessionStorage` 与所有同源 Storage 共享的）
2. 原型兜底分支带 `this` 守卫（默认关闭）
3. 原始方法只捕获一次；备份 IO 永远走原始方法（不会递归）
4. wrapper 带 `active` + `Symbol.for('dsh.draft-saver.patch')`；dispose 后旧引用**透明转发**
5. dispose 只在"当前还是我"时还原；被别人覆盖则 `needs-refresh` 且**不动他的人工补丁**
6. `WeakMap<storage, handle>` 单例；另一个 module 实例（HMR/双 eval）靠 `PATCH_MARK` 判 `conflict`
7. dispose 幂等、不抛错、**绝不删 `dsh-draft-saver.backup.v1`、绝不 `clear()`**
8. `lastRead` 与通知总线都是**每次 mount 一份**（关掉再开不带旧状态）

外部复核（Pi）抓出并已修的两条 P1：

- **坏备份不许顶替好草稿**：`backupRead()` 现在校验 `key` 前缀 + `raw` 能不能解析成草稿。不合格就当"没有备份"，
  把用户原来的草稿交回去；**坏记录原样留着**（可人工恢复），等下次合法写入自然替换。
- **`this` 守卫**：`localStorage.setItem.call(sessionStorage, ...)` 这类重绑调用只写它自己的接收者，
  **不许**镜像进 `localStorage` 的备份。

## 已知边界

- **回收箱删除的一瞬间，左侧「未分组」可能闪现一下（不到 1 秒）**。原因是删除会先清掉「已归档」标记，
  DSH 立刻把这条会话按「未归档」重新分组，而会话列表要到下一步才刷新。
  **数据 100% 安全**（目录已在回收箱、journal 正常），只是视觉上重渲染了一次。
  彻底消除需要加一条「两阶段删除」路由，已评估为不值得（见 `docs/S4-封板简报.md` 的已知限制）。
- 守卫处于 `needs-refresh` / `unsupported` 时，目前只有 `console.warn` + `window.__DSH_TOOLBOX_DRAFT__`，
  **还没有可见的界面提示**（复核 Bug 单 P2-3，待办）。
- `plugin-zh` 必须走路 B（DOM + 完整还原）：路 A（官方 locale 注入）已判死 ——
  `resolveText` 对字符串原样返回，且 `dsh-app-boot` 里 `ctx.locale` 出现 0 次，解析全在 boot 阶段。
- 迁移（S4–S5）前必须卸载对应的旧 bundle，并做启动自检（同名工具 / 已 patch 的 Storage / 旧 slot id）。

## 许可

MIT


---

## 回收箱（S4）

删除不是「立即消失」，而是**移入回收箱**：

- 删除时只把会话目录移进私有垃圾箱，并清掉归档标记、工作区行、projection cache；
- 回收箱在「历史归档」面板的二级页签里，**不新增侧栏入口**；
- 保留期**可配置**：默认 **7 天**，可选 **3 / 7 / 14 / 30 / 60 天**，手动填值范围 **1–90 天**；
- 到期后由清理器物理删除（启动时扫一次 + 每小时扫一次，每次现读配置）；
- 恢复：把目录搬回原位，并按删除时记下的工作区成员身份放回原工作区；
- 彻底删除：先补清账务（标记/工作区行/缓存），清不掉就拒绝，避免留下幽灵。

HTTP 路由（全部要求进程内令牌 + Host 白名单 + 同源，响应只回白名单字段）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/archive-manager/token` | 下发进程内令牌 |
| GET | `/api/archive-manager/list` | 列归档会话 |
| POST | `/api/archive-manager/unarchive` | 取消归档 |
| POST | `/api/archive-manager/delete` | 移入回收箱 |
| GET | `/api/archive-manager/trash` | 回收箱列表（含剩余天数） |
| POST | `/api/archive-manager/restore` | 从回收箱恢复到原位 |
| POST | `/api/archive-manager/purge` | 彻底删除（需 `confirm: true`） |

`archiveHttpApi` 开关**默认关闭**；它只在本机打开一个令牌保护的通道，响应里不含绝对路径与 nonce。
