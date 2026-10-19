# S4-c · typert RPC 死胡同排查报告

> 日期：2026-10-17
> 目标：为 `dsh-toolbox` 建立真实的 `ctx.remote.archive` RPC 通道（typert codegen）
> 结论：**单包结构无法走通官方 typert 生成器**，因构建顺序死锁（产物 ← exports ← 产物）。
> 处置：**止损**，退回官方 `webServer` 精确路由 + 进程内 token；基线 267 绿未受影响。
> 本文可作为向 DeepSeek 上游提 issue 的最小复现材料。

---

## 一、排查过程（五个假设，逐一证伪）

| # | 假设 | 验证方式 | 结果 |
|---|---|---|---|
| 1 | 生成器是「喂一个文件」的 CLI | `npm view` + 读 `lib/types/*` | ❌ 它是 **tsdown/rolldown 插件** + 工作区分析器 |
| 2 | `package.json` 缺 `./typert` export | 补 `./typert` + `./remote` 后重跑 | ❌ 仍 0 产物 |
| 3 | 依赖没装（`dsh-typert-protocol`） | 精确安装同版本后重跑 | ❌ 仍 0 产物 |
| 4 | `tsconfig` 命名不对 | 建 `tsconfig.host.json` 后重跑 | ❌ 仍 0 产物 |
| 5 | 必须改造成 monorepo | grep `pnpm-workspace` / `workspaces` / `readdirSync` | ❌ **生成器里一个都没有**，它不扫目录 |

## 二、真正的链路（源码证据，版本 0.2.1-alpha.4）

```js
// findWorkspaceRoot(start)：只认「同时含 tsconfig.host.json 与 packages/」的目录
while (!existsSync(join(current, "tsconfig.host.json")) || !existsSync(join(current, "packages"))) { … }

// WorkspaceAnalyzer 构造函数：tsconfig 文件名是硬编码默认值
hostConfig: options.hostConfig ?? "tsconfig.host.json",
clientConfig: options.clientConfig ?? "tsconfig.client.json",
faces: options.faces ?? ["host", "client"],

// L469 —— 注册表的唯一来源
for (const reference of aggregate.projectReferences) { … }

// L2285-2286 —— 每个 reference 被当作真实 TS 项目解析
const host = aggregate && … && Object.hasOwn(raw, "references");
const parsed = ts.parseJsonConfigFileContent(read.config, host, dirname(compilerPath), …);

// discoverPackages()：不扫目录，全部来自 loadRegistrations()
discoverPackages(includeManifest) {
  const registrations = this.loadRegistrations()
    .filter(r => this.options.faces.includes(r.face) && …)
    .filter(r => this.registrationHasSurface(r));    // ← 死锁所在
  …
}

// hasTypertExport()：surface 的判据
return Object.hasOwn(exportsField, "./typert")
    || Object.hasOwn(exportsField, "./client/typert")
    || Object.hasOwn(exportsField, "./remote");
```

**完整链条**：
`tsconfig.host.json` 的 `references[]` → `aggregate.projectReferences` → 每个 reference 解析为真实 TS 项目 → `registration` → `discoverPackages()` 过滤（含 `registrationHasSurface`）→ `analyze()` → `FaceModelEmitter` → artifact。

## 三、死锁

```text
要出产物  →  必须被 discoverPackages() 收录
被收录    →  必须 registrationHasSurface 为真
surface   →  package.json 里必须声明 ./typert 或 ./remote
声明了    →  指向的 lib/typert.host.js 尚不存在
指向空文件→  npm pack 会带一个坏清单（禁止）
```

这是一个**闭环**，且我们拒绝用「先提交一个真文件占位」的方式打破它——那会让最终包携带假产物。

## 四、我们实际走到哪一步（可复现的最小状态）

1. 建 `tsconfig.host.json`（`files: []` + `references: [{path:'./tsconfig.host.src.json'}]`）
2. 建 `tsconfig.host.src.json`（`composite: true` / `emitDeclarationOnly` / `rootDir: ./src` / include `src/host/**/*.ts`）
3. `tsc -b tsconfig.host.json --verbose` → **通过**（两个项目都真的构建了）
4. `new WorkspaceTypertGenerator(root).discover()` → **`registrations: 0`**

即：**项目图已验证合法，卡在 surface 过滤**。

## 五、上游可以回答的问题（建议 issue 正文）

1. 第三方**单包**（非 DSH monorepo）是否支持 typert codegen？
2. `registrationHasSurface` 除 `exports` 的三个子路径外，还接受什么声明方式（例如 manifest 的 `dsh.typert` 字段）？
3. 是否提供**bootstrap 模式**（先出产物、后补 exports），或在生成时忽略 `registrationHasSurface`？
4. 生成产物若不进 `exports`，客户端是否能通过其他路径加载 `typert.remote-client`？

## 六、替代方案（未采纳，供决策）

Pi 建议的 **bootstrap 临时副本**：把包复制到临时目录 → 在那里放占位 `lib/typert.host.js` + 临时 `exports` → 跑生成器 → 把**真实产物**拷回发布包 → 删占位。
- 优点：不污染发布包，可能真的破死锁；
- 风险：若生成器读取占位文件内容，可能产出空表；
- 状态：**未执行**（本轮按决策直接止损）。

## 七、现状

```
基线        267 / 267 绿 · 0 跳过
HEAD        8d7e3ac（+ 本报告与依赖清理）
依赖树      回到 3 个 devDependency（cordis / schemastery / esbuild）
产物        0（未提交任何假产物）
exports     未改动，包里不会出现指向空文件的清单
```

## 八、一句话

> 这不是「RPC 不可用」，而是「官方生成器把 surface 声明当输入，而 surface 声明又要求产物先存在」。
> 我们选择**不造假、不污染发布包**，把这条边界连同证据一起交给上游。
