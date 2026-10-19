# dsh-toolbox · S4-a 复核与 R0 真实 HTTP 测试补充

> 审查对象：commit `a3230d2`（S4-a panel-menu）+ 未跟踪的 S4-b WIP
> （`src/host/features/archive/paths.js` / `route-guard.js` / `test/archive-*`）
> 审查日期：2026-10-17
> 说明：S4-b 文件目前是**未提交的 WIP**；下面的 R0 结论基于我读取时的快照，Harness 改完请按同一组测试重跑。

---

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| **S4-a panel-menu** | **功能代码 PASS**；`<style>` 随 trigger 卸载、4 个 effect 全 `env.track`、dispose 干净。附 1 个 P2 测试债：layout fallback 测试没真正走到 `collectPanels` |
| **R1/R2/R3/R7** | 报告里的 13/13 绿与代码方向一致：严格两级、junction（含 root 内）、allowlist、scrub 边界都锁住了；**提交后再复核一次** |
| **R0 当前 route-guard** | **有硬伤，不能标全绿**：Host/DNS rebinding 可绕过；loopback 不是认证；常量头不是认证；Node fetch 不模拟 CORS；service 错误会泄露绝对路径；测的是独立 server 不是宿主真正挂载的 route |
| **S4-b 路由挂载** | **暂不允许**：先修下面 P0-1 / P0-2 / P0-3，并把 R0 测试从“独立靶场”升级到“宿主真实挂载” |

---

## 1. S4-a：panel-menu 复核

### 1.1 做对的地方

- `HIDE_CSS` 是 `PanelMenuTrigger` 组件里的 React `<style>`；feature off → slot disposer → 组件卸载 → style 移除。
  你控制台看到的 `display:none` / 恢复与代码路径一致。
- `applyBody` 里 4 个 `ctx.effect` 全部经过 Proxy 转成 `env.track(target.effect(...))`；
  加上 `resetMenuState` 共 5 个 tracked；`dispose` 后两个 slot + 两个字典都注销。
- `layout` 走 `Reflect.get` → 失败/空 → `ctx.get('layout')`，实现方向正确。
- `menuState` / `listeners` 虽仍是模块级，但 mount/dispose 都 reset，`useMenuState` 卸载会移除 listener；P2 可接受。

### 1.2 仍需补的 P2

**layout fallback 测试是假的。**
`test/panel-menu-feature.test.mjs` 的 `layoutThrows` 只调用 `mount()`；
但 `mount` 根本不读 `layout`，`collectPanels()` 只在菜单打开/点击时才读。
所以把 fallback 删掉，这个测试仍然会绿。

**补法**：导出一个纯函数（或暴露 `collectPanels`），用 fake `ctx`（`layout` getter 抛错、`ctx.get('layout')` 返回 stub）
调用一次 `collectPanels`，断言 `run()` 能调到 `selectPanel`；或者用 React stub 触发 trigger 的 `onClick`，断言不抛。

另外：
- `README.md` 还停在 S3 / 106 项，S4-a 状态没更新（P3）。
- profile 里旧 `dsh-panel-menu` / `dsh-archive-manager` 还在 bundle 列表（据我看到的快照）；
  S4 前必须卸载，否则双入口/双 style。

---

## 2. R1 / R2 / R3 / R7：报告结论与代码一致

报告里的红灯与修法方向正确：

- **R1** `removeSessionDir` 现在要求严格两级（`dirname(dirname(real)) === rootReal`），拒绝 project / session 内子目录；
- **R2** 先 `lstat` 拒绝 symlink/junction（包括指向 root 内另一个 session），目标必须是 directory；
- **R3** `SAFE_SESSION_ID` allowlist 取代 denylist；`CON/NUL/COM1`、空格、编码、非字符串都挡；
- **R7** `safeCacheKey` + scrub 只动 `tables.sessions` 的安全 key。

我看到的 S1–S8 路径矩阵 10/10 通过；R1–R7 红线矩阵 13/13 通过（按报告）。  
**提醒**：这些文件还没提交；提交后需要重跑一次全量，不要拿 WIP 当已交付。

---

## 3. R0 当前 `route-guard.js` 的问题

### P0-1（最高）Host / DNS rebinding：当前会被直接打穿

`isSameOrigin()` 只比较 `Origin` 和请求的 `Host`，两者都可以由请求方伪造。

我实际起了一个真实 `node:http` 服务器，发：

```http
POST /api/archive-manager/delete HTTP/1.1
Host: evil.example
Origin: http://evil.example
x-dsh-toolbox: 1
Content-Type: application/json

{"sessionId":"session-aaaaaaaa-1111-2222-3333-444444444444"}
```

结果：

```
status 200
body {"ok":true,"removedDir":true}
deleted [ 'session-aaaaaaaa-...' ]
```

**这不是理论风险**：
- raw client / 本地进程可以伪造 Host + Origin；
- 浏览器 **DNS rebinding** 后，页面 origin 就是 `http://evil.example`，Host 也是 `evil.example`，属于**同源**，不会触发 preflight；
- 自定义头 `x-dsh-toolbox: 1` 在“同源”下可以直接发。

**修法**：
- 用 `webServer.getOrigin()` 的实际 host/port 建 allowlist：
  `127.0.0.1:<port>`、`localhost:<port>`、`[::1]:<port>`（以及你真实使用的 LAN/隧道 origin）；
- **不要拿请求里的 Host 当权威**；
- 比较完整 origin（protocol + host + port），不是只比 host；
- 如果还有 DNS rebinding 威胁，Host allowlist 是主防线，token 不能替代（rebinding 后 token 也能同源读）。

### P0-2 loopback 不是认证：反代/隧道会让它失效

当前只看 `req.socket.remoteAddress`。如果 DSH 前面有一个本机反向代理/tunnel，
所有远程请求的 remoteAddress 都是 `127.0.0.1`，loopback 检查直接失效。

补测试：

```js
authorizeRequest({
  method: 'POST',
  peer: '127.0.0.1',
  headers: {
    'x-forwarded-for': '203.0.113.5',
    'content-type': 'application/json',
    'x-dsh-toolbox': '1',
  },
})
```

当前会放行。没有可信代理配置时，应该 403；或者不要用 loopback 当认证。

### P0-3 `x-dsh-toolbox: '1'` 是 CSRF 预检开关，不是认证

常量头只能逼浏览器走 preflight；raw client / 本地进程 / 伪造 Host 都能发。
要么：
- 明确命名并注释为“CSRF header”，补 Host allowlist；
- 要么换**每进程随机 token**（不写 URL/日志，走已认证通道下发）或 DSH auth。

否则报告里不能写“认证完成”，只能写“loopback + CSRF 预检”。

### P1-4 Node `fetch` 不执行 CORS，矩阵会假绿

`test/support/route-attack.mjs` 用 Node fetch 发跨源请求；Node 会**真的把 POST 发出去**，
真实浏览器可能先 preflight 然后根本不发。

必须加 Playwright 页面（另一起源 `127.0.0.1:<attackerPort>` / `localhost:<attackerPort>`）：

- `<form>` `text/plain` / `application/x-www-form-urlencoded`
- `fetch(..., { mode: 'no-cors' })` + `text/plain`
- 带 `x-dsh-toolbox` 自定义头的 fetch（preflight）
- sandbox iframe / `Origin: null`
- `Access-Control-Request-Private-Network: true`

断言 **服务端 `onDelete` 计数 = 0**，不要只看 response.status。
CORS 会把响应藏掉，但删除可能已经发生。

### P1-5 service 错误会泄露绝对路径

当前 route 直接把 service 的 `error` / `warning` 回给客户端。我复现：

```js
onDelete -> { ok:false, error:'C:\\Users\\zhou0\\.dsh\\sessions\\secret' }
```

返回 409 body 含该路径。

**修法**：route 只返回白名单错误码/通用文案；不返回 service 原始 message。
**补测试**：`onDelete` 返回带 `C:\` / `/Users/` 的错误，响应体不得包含。

### P1-6 测的是独立 `createArchiveServer`，不是宿主真正挂载的 route

`route-guard.js` 目前是一个独立 `createServer`。
真正的 `ctx.webServer.register` 完全可以继续用旧 handler，而 R0 矩阵仍然全绿。

**必须加集成测试**：
- fake `webServer` 捕获 `register` 的 route；
- 用真实 HTTP 打这个 route；
- 断言 route 走 `authorizeRequest`；
- 没有 auth/token 时**不注册 delete 路由**（fail closed）；
- `enabled:false` 时 404。

### P1-7 同源比较只比 host，不比 scheme / port 的完整 origin

`isSameOrigin('https://127.0.0.1:3080', '127.0.0.1:3080')` 当前为 true。
同源应该是 protocol + host + port。补测试。

### P2 HTTP 边角

- `Transfer-Encoding: chunked` 发 >64KB；`Content-Length` 撒谎（声明小、实际大）；aborted body（end 前断开）→ 都不能触发删除。
- `OPTIONS` 断言没有 `Access-Control-Allow-Origin/Headers/Methods/Credentials/Private-Network`；当前没有，但别为了“方便调试”加上。
- 重复/并发 delete：route 的 `onDelete` stub 现在永远 200；R4/R5 服务层测试必须断言第二次 404/409、onDelete 只执行一次。
- 限流/审计：R6 后续；不是 R0 阻塞项，但别忘。

---

## 4. 建议直接加的 R0 测试（按优先级）

| ID | 测试 | 期望 |
|---|---|---|
| R0-Host | raw HTTP：`Host: evil.example` + `Origin: http://evil.example` + `x-dsh-toolbox:1` + valid id | 401/403；onDelete=0；**当前是 200，红** |
| R0-Proxy | `peer=127.0.0.1` + `X-Forwarded-For: 203.0.113.5` | 403，除非明确配置可信代理 + 校验 XFF；**当前放行** |
| R0-Token | 无 token / 错 token / 旧 token | 401/403；常量 `1` 不算 |
| R0-Browser | Playwright 跨源 form/no-cors/custom-header/Origin:null/PNA | onDelete=0 |
| R0-CORS | OPTIONS 来自 evil | 204/405 且无任何 ACAO/ACAH/ACAM/ACAC/PNA |
| R0-Leak | service 返回 `C:\secret` | 响应无绝对路径 |
| R0-Integration | 宿主 `webServer.register` 真正挂载的 handler | 走 guard；无 auth/disabled 时 404 |
| R0-Chunk | chunked >64KB / CL 撒谎 / abort | 413/400；onDelete=0 |
| R4-Replay | 同一 id 连续两次 / 并发两次 | 第二次 404/409；onDelete=1 |

---

## 5. 放行建议

1. **S4-a**：可以 PASS；补 layout fallback 的真实测试即可。
2. **R1/R2/R3/R7**：提交后重跑 135，确认 WIP 与报告一致。
3. **R0**：**先修 P0-1（Host allowlist/DNS rebinding）、P0-2（loopback 不等于认证）、P0-3（常量头不是认证）**；
   再加 P1-4 浏览器 CORS、P1-5 错误路径、P1-6 真实挂载集成。
4. 以上全绿前：**不要把 delete 路由挂到 `ctx.webServer.register`**，也不要标 R0 完成。
5. R4/R5/R6 服务层测试随后做；在服务层完成前，路由只能算“传输层门卫”，不是“删除安全”。

---

## 6. 证据与文件

- S4-a 代码：`src/client/features/panel-menu.js`
- S4-a 测试：`test/panel-menu-feature.test.mjs`（layout fallback 未真正触发）
- S4-b WIP：`src/host/features/archive/paths.js`、`route-guard.js`
- 路径矩阵：`test/archive-paths-safety.test.mjs`（S1–S8）、`test/archive-path-redlines.test.mjs`（R1/R2/R3/R7）
- R0 靶场：`test/archive-route-redlines.test.mjs`、`test/support/route-attack.mjs`、`test/fixtures/legacy-archive-route.mjs`
- 我实际复现：Host 伪造 → `200` + onDelete 调用；service 错误 → 响应含绝对路径。
