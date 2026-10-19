# dsh-toolbox · S4-c RPC 死锁与官方退路

> 现状：TS 项目图合法（`tsc -b` 通过），但 `discover()` 的 `registrationHasSurface` 要求
> `package.json` 先有 `./typert` exports；没有 exports 不生成产物，没产物又不能安全写 exports。
> 结论：**先破死锁（临时 bootstrap），破不了再退回官方 `webServer` 精确路由 + 进程内 token。**
> 不建议为了 RPC 去改整个仓库结构，也不建议手写假 typert。

---

## 0. 先明确：这不是“RPC 不可用”，是“构建顺序死锁”

`registrationHasSurface` 只要求 surface 声明存在。  
可以在**临时构建副本**里先放一个真实存在的占位导出，跑生成器；生成出真产物后，把真产物和真 exports 一起写回发布包。  
**占位文件不进最终包，最终包里只有生成产物。** 这不是“假代码交付”，是 bootstrap。

### 流程（建议先试，时间盒 1–2 小时）

1. 复制一份包到临时目录（不要动工作区）。
2. 在临时 `package.json` 加：
   ```json
   "exports": { "./typert": "./lib/typert.host.js" }
   ```
   并放一个**语法合法、无副作用**的 `lib/typert.host.js`（例如 `export const __bootstrap = true`）。
3. 用 alpha.4 生成器跑 `generate(['dsh-toolbox'], ['host', ...])`。
4. 断言：
   - `.host.js` / 客户端 remote 产物存在、非空、含 Remote 元数据；
   - 不是把 bootstrap 文件原样复制。
5. 把**真实生成产物**拷回发布包，写真实 `exports`/`files`；删掉 bootstrap。
6. 干净 clone → `npm ci` → build → `npm pack` → 临时 profile 安装 → 真 echo。

### 失败判定

- 生成器读占位文件内容并据此生成空表 → 失败；
- 产物只 host、没有客户端 remote → 失败；
- 最终包 `npm pack` 后 import/echo 失败 → 失败。

失败就止损，走下面的退路；不要再逆向 `discover()`。

---

## 1. 官方退路：`webServer` 精确路由 + 进程内 token

`ctx.webServer` 是官方扩展点，不依赖 typert codegen。之前的 `route-guard` 已经把攻击面收得很窄：

- `kind: 'exact'`，只 POST；
- loopback peer / Host allowlist（真实监听 origin，不信请求 Host）；
- 拒绝 `X-Forwarded-*`（除非显式可信代理）；
- 强制 `application/json`、64KB、sessionId allowlist；
- 无 CORS、错误脱敏；
- per-process 32B token、逐字节比较；
- 默认 `enabled:false`，不注册。

### 关键：token 怎么安全送到 UI

**不要**放进 client bundle、localStorage、URL、配置文件。

建议二选一：

**A. 同源 token 端点（推荐，简单）**

- `GET /api/archive-manager/token`，exact、无副作用、`Cache-Control: no-store`；
- 同样做 Host allowlist + 无 CORS；只允许同源页面读取；
- 客户端只在内存闭包持有 token，页面刷新重新取；
- delete 路由继续要 token + origin/loopback。
- 这个端点本身不删数据，只发进程内凭证；DNS rebinding 由 Host allowlist 挡；跨源页面读不到（无 ACAO）。

**B. `webServer.tapIndex` 注入**

- 宿主在 index HTML 里注入 `<meta name="dsh-archive-token" content="...">`；
- 必须确保 index 不被缓存（`no-store`），否则重启后 token 过期；
- 同源脚本可读，和 A 的信任模型一样；XSS 仍能读，这是同源信任边界。

### 退路的硬要求

- **只允许 same-origin**；无 `Access-Control-Allow-Origin`；
- Host allowlist 来自真实监听地址，不信请求 Host；
- token 不落盘、不进 URL/日志；
- `enabled:false` 默认；只有显式开启且 token/origin 配好才注册；
- 真实 Playwright 跨源/表单/no-cors/Origin:null/PNA 测试，断言 `onDelete=0`；
- 进程重启 token 立即失效，客户端重新取；
- 审计只记 `id/actor/result`，不记 token。

这不是“新增未认证端点”：delete 仍要进程内 token；token 端点只发凭证、不执行操作。  
但它是**多一个网络面**，所以 route-guard 的检查一条不能少。

---

## 2. 不建议的方案

| 方案 | 原因 |
|---|---|
| 手写 `ctx.remote.archive` 对象 | typert codegen 不是运行时注册；假绑定会得到空表 |
| 为了生成器把包改成完整 monorepo | 你已证明生成器只读 tsconfig registration；改结构不解决问题 |
| 为了跑 pack 先写空 `./typert` 真文件提交 | 最终包会带假产物；只能在临时副本 bootstrap |
| token 放 client bundle / localStorage / URL | 同源/DNS rebinding/日志都能拿到；重启后旧 token 污染 |
| 静态 token | 没有意义；必须每进程随机 |
| Slot 直接穿透调 host | Slot 是渲染扩展点，不是 host RPC；不要幻想“组件里直接 call 后端” |
| 回到旧的无 token `/api/archive-manager/delete` | 已明确是 R0 红区，不能回 |

---

## 3. 决策建议

1. **先花 1–2 小时做 bootstrap 临时副本**：如果能把 host + remote 真产物跑出来，S4-c 继续走 typert，最干净。
2. **bootstrap 失败 → 立刻切 `webServer` 精确路由 + token 端点**；把 route-guard 的 30 项和 Playwright 证据重新挂上。
3. **同时给上游提 issue**：单包 + `discover()`/`registrationHasSurface` 的 bootstrap 顺序问题；附最小复现。不要等上游。
4. 无论走哪条，**S4-b 的 267 绿、journal 多进程锁、trash 状态机不许回退**。

**一句话：RPC 死锁是构建顺序问题，先用临时 bootstrap 破；破不了就退回官方 `webServer` 路由 + 进程内 token。不要为了 RPC 造假，也不要为了生成器改仓库结构。**
