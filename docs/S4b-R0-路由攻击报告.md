# S4-b · R0 路由攻击与防御报告（第二版 · 复核后修订）

> 对象：`/api/archive-manager/delete`
> 日期：2026-10-17
> 第一版结论「七道门守住了」**已被 Pi 复核推翻**。本版记录被打穿的三条 P0、修法、以及仍然开着的缺口。
> 复现：`node tools/prove-route-red.mjs`（打旧路由，应红 14 条）、`npm test`（打守卫，应全绿）

---

## 一、第一版错在哪（Pi 的复核）

第一版把「请求的 `Host`」当成同源校验的权威。这等于**让攻击者自己签通行证**。

Pi 用一条 raw HTTP 请求就打穿了：

```http
POST /api/archive-manager/delete HTTP/1.1
Host: evil.example
Origin: http://evil.example
x-dsh-toolbox: 1
Content-Type: application/json

{"sessionId":"session-aaaaaaaa-1111-2222-3333-444444444444"}
```

```
status 200
deleted [ 'session-aaaaaaaa-...' ]
```

三条 P0 + 三条 P1：

| ID | 问题 | 后果 |
|---|---|---|
| **P0-1** | 用请求里的 Host 当同源权威 | **DNS rebinding** 后 `Origin` 与 `Host` 都是 `evil.example`，天然"同源"，直接绕过 |
| **P0-2** | 只认 `remoteAddress` 是 loopback | 前面挂 Nginx / 内网穿透时，**所有**远程请求看起来都是 127.0.0.1 |
| **P0-3** | 常量头 `x-dsh-toolbox: 1` 当认证 | 它只能逼浏览器预检；raw client / 本地进程随便发 |
| **P1-4** | 用 Node `fetch` 测 CORS | Node **不执行** CORS 预检，测试假绿 |
| **P1-5** | 把 service 的 `error` 原文回传 | 响应体里出现 `C:\Users\zhou0\...` 绝对路径 |
| **P1-6** | 测的是独立 server，不是宿主挂载的 route | 宿主完全可以继续用旧 handler，而矩阵照样全绿 |

---

## 二、修法（按 Pi 的红线逐条）

### P0-1 真实 origin 白名单，不再信请求头

```js
// 独立靶场：从 server.address() 推导，它真的监听在哪就是哪
originsFor(server) -> ['http://127.0.0.1:<port>', 'http://localhost:<port>', 'http://[::1]:<port>']

// 宿主挂载：由调用方显式传入真实 origin，拿不到就 fail closed
registerArchiveRoutes({ webServer, token, origins })
```

- `Host` 必须落在白名单里 → rebinding 送来的 `Host: evil.example` 直接 403；
- `Origin` 若存在，必须**完整 origin**（scheme + host + port）等于白名单之一 → `https://` 与 `http://` 不再混淆（P1-7）；
- 白名单为空 → **一切拒绝**（`no allowed origins configured`）。

### P0-2 loopback 不是认证

`X-Forwarded-For` / `X-Forwarded-Host` / `X-Forwarded-Proto` / `Forwarded` / `X-Real-IP`
任意一个出现 → **403 `proxied request refused`**，除非显式 `trustProxy: true`（当前不启用）。

### P0-3 随机 token 才是凭证

- `createRouteToken()` = 32 字节随机 → 64 位 hex；
- 请求必须带 `x-dsh-toolbox-token`，**逐字节比较**；
- token 缺失或短于 32 → **401 fail closed**；
- 常量头 `x-dsh-toolbox: 1` 保留，但**语义明确为 CSRF 预检触发器**，注释与文档都不再称它为认证。

### P1-5 错误响应脱敏

service 返回的任何 `error` / `warning` 原文**永不**回传：

```js
{ ok: false, error: 'delete refused' }        // 409
{ ok: true, removedDir: true, warning: 'deleted with warnings' }  // 200
```

### P1-6 测的就是宿主会挂的那份

`createDeleteHandler({guard, onDelete, peerOf})` 被**两条路径共用**：

- 独立靶场 `createArchiveServer`；
- 宿主挂载 `registerArchiveRoutes({ webServer, ... })`。

集成测试用一个 fake `webServer` 捕获 `register` 的 route，再用真实 HTTP 打它：
无凭证 → 401 且 `onDelete` 未执行；有凭证 → 200 且执行一次。
未配置 token 或 origins → **不注册**（fail closed）。

---

## 三、红灯（旧路由，14 条）

`node tools/prove-route-red.mjs`：

```
total: 16   RED: 14   GREEN: 2
```

绿的两条是「合法请求可用」和「拒绝响应不含绝对路径」——旧路由恰好也满足后者（它压根不返回错误）。

攻击面覆盖：Host 伪造（rebinding）、跨源、无凭证、错误 token、CSRF 头单独存在、
`text/plain`、缺 Content-Type、GET、DELETE、OPTIONS、声明超大 body、chunked 超限、
坏 JSON、非字符串 sessionId、设备名 id。

---

## 四、绿灯

```
守卫矩阵         30 项全绿
全量             170 项 → 168 绿 + 2 跳过（Playwright 未安装）
prove-route-red  16 项 → 14 红（打旧路由）→ 矩阵确实咬人
```

关键对照：

| 攻击 | 旧路由 | 新守卫 |
|---|---|---|
| `Host: evil.example` + 同源 Origin + 有效 token | **200 删了** | **403 unexpected host** |
| 跨源但 token 正确 | **200 删了** | **403 cross-origin** |
| 只有 CSRF 头、没有 token | **200 删了** | **401** |
| 错误 token | **200 删了** | **401** |
| 带 `X-Forwarded-For` | **200 删了** | **403 proxied** |
| `text/plain` / 缺 Content-Type | **200 删了** | **415** |
| GET / DELETE | **200 删了** | **405** |
| chunked 超 64 KB | **200 收下** | **413** |
| service 报错含 `C:\...` | 原文回传 | **`delete refused`**（无路径） |
| 合法 UI 请求 | 200 | **200** |

---

## 五、仍未闭合的缺口（诚实清单）

1. **P1-4 浏览器 CORS 未经真机验证。** 本机**没有安装 Playwright**，
   `test/browser-cors.test.mjs` 目前是 skip 状态（用例已写好：`<form>` / `mode:'no-cors'` /
   自定义头预检 / sandbox iframe `Origin: null`，断言均为**服务端 `onDelete` 计数 = 0**）。
   安装方式：`npm i -D playwright && npx playwright install chromium`（约 100 MB，需走代理）。
   **在它跑通之前，"浏览器侧不可绕过"这句话不算证明。**
2. **token 的交付通道还没做。** 每进程随机 token 现在只能由调用方注入；
   客户端 UI 迁移时必须通过**已认证的同源通道**下发，不能放进 URL、日志或页面里的明文常量。
3. **R4/R5（服务层）未做**：只删已归档且非 live、删除前重读状态、防重放、先删文件后清状态、可恢复重命名。
4. **R6 剩余**：限流、审计日志。
5. **路由尚未挂到 `ctx.webServer.register`。** 按 Pi 的要求，R0 全绿 + 真机浏览器验证之前不挂。

---

## 六、一句话

> 第一版是"让攻击者自己证明自己是自己"；第二版是"只认我真实监听的 origin、只认我这一进程刚生成的 token、只认没有经过代理的 loopback 连接"。
> 而"这个会话能不能删"仍然由服务层另行决定——两道闸门互不替代。
