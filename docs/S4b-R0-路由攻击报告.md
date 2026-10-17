# S4-b · R0 路由攻击与防御报告

> 对象：`/api/archive-manager/delete`（旧 `dsh-archive-manager` 路由，迁移前行为）
> 日期：2026-10-17
> 结论：**旧路由对 10 类攻击全部返回 200**；新守卫 `route-guard.js` 把它们全部拦成 401/403/405/413/415。
> 复现：`node tools/prove-route-red.mjs`（打旧路由，应红 10 条）和 `npm test`（打守卫，应全绿）。

---

## 一、为什么这条红线最高优先级

`webServer.register({ kind: 'exact' })` 注册的路由：

- **先于 API gateway 前缀匹配**——它不在 gateway 的鉴权覆盖范围内；
- `webServer` 只禁止 wildcard 绑定，**允许绑定具体 LAN IP**；
- 插件路由**自身没有任何** `authorization` / `Origin` / CSRF 检查。

后果：同一局域网内的任意客户端，或用户浏览器里打开的任意恶意网页，只要发一个
`POST`（用 `text/plain` 就能避开 CORS 预检），就能**物理删除**会话目录。

这不是理论风险：旧实现里这条路由直接调用 `service.delete(sessionId)`，而
`delete()` 会 `rmSync` 掉 `<DSH_HOME>/sessions/<project>/<session>`。

---

## 二、靶机：忠实复刻的旧路由

`test/fixtures/legacy-archive-route.mjs` 用真实 `node:http` 服务器复刻旧行为，
每处缺失都标注了对应红线：

```js
// FLAW R6: no method check. GET / PUT / DELETE all reach the handler.
// FLAW R0: no peer check. A LAN client reaches this as easily as localhost.
// FLAW R0: no Origin / Sec-Fetch-Site check.
// FLAW R0: no Content-Type requirement: `text/plain` avoids the preflight.
// FLAW R6: no body size cap: the whole thing is buffered into a string.
```

**为什么用真实 socket 而不是 mock**：CSRF 的关键前提是"浏览器能无预检地发出这个请求"。
只有真实 HTTP 请求才能证明这一点，mock 掉的 `fetch` 什么也证明不了。

---

## 三、红灯：10 类攻击全部通过（旧代码）

`node tools/prove-route-red.mjs` 的实际输出：

```
[RED] R0-a  cross-origin POST (Origin: evil.example)        -> got 200, expected 403
[RED] R0-b  simple POST, no Origin, no custom header (CSRF) -> got 200, expected 403
[RED] R0-c  text/plain body (skips preflight)               -> got 200, expected 415
[RED] R0-d  missing Content-Type                            -> got 200, expected 415
[RED] R6-a  GET                                             -> got 200, expected 405
[RED] R6-b  DELETE                                          -> got 200, expected 405
[RED] R6-c  OPTIONS with evil Origin                        -> got 200, expected 204/405
[RED] R6-d  80 KB body                                      -> got 200, expected 413/400
[RED] R6-e  malformed JSON                                  -> got 200, expected 400
[RED] R6-f  missing / non-string sessionId                  -> got 200, expected 400
[GREEN] R0-f  the legitimate request still works
[GREEN] R6-g  a refused response leaks no absolute path
[SKIP]  R0-e  non-loopback peer（loopback socket 无法产生，由单元测试覆盖）

total: 13   RED: 10   GREEN: 3
```

**每一条红都是一次真实可执行的删除。** 换句话说：在旧实现上，攻击者不需要任何凭证。

---

## 四、防线：七道门

`src/host/features/archive/route-guard.js`，按"最便宜的先拒"排序：

| # | 门 | 拒绝结果 | 挡住的是 |
|---|---|---|---|
| 1 | 只接受 loopback peer（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`） | 403 | 局域网里的其他机器 |
| 2 | 只接受 POST；OPTIONS → 204 且不带任何 CORS 头 | 405 / 204 | 方法混淆；不让跨源读到响应 |
| 3 | 必须带自定义头 `x-dsh-toolbox: 1` | 403 | 浏览器简单请求（表单/图片/`text/plain`）——自定义头会强制预检 |
| 4 | `Origin` 若存在必须与请求的 `Host` 同源 | 403 | 恶意网页 |
| 5 | `Content-Type` 必须是 `application/json` | 415 | `text/plain` 这种零预检载体 |
| 6 | body 上限 64 KB（流式计数，超限 chunk **直接丢弃**） | 413 | 内存打爆 / 慢速大包 |
| 7 | `sessionId` 再过一遍 `paths.js` 的 allowlist | 400 | 路径穿越、设备名、编码绕过 |

另外：错误响应只回 `{ ok: false, error: '<一句英文>' }`，**不含绝对路径、堆栈、内部原因**。

设计原则：**这个 handler 只做传输层校验，不决定"能不能删"**。谁可以被删是服务层的事（R4/R5）。

---

## 五、绿灯：同一套矩阵打守卫

```
R0/R6 攻击矩阵          19 项 → 18 绿 + 1 跳过（non-loopback 由单元测试覆盖）
全量测试                156 项 → 155 绿 + 1 跳过
prove-route-red         仍报 10 红（对旧路由），矩阵确实咬人
```

关键对照：

| 攻击 | 旧路由 | 新守卫 |
|---|---|---|
| 跨源 POST | **200 删了** | **403 本地访问限定 / 跨源拒绝** |
| 无自定义头的简单 POST | **200 删了** | **403 missing client header** |
| `text/plain` | **200 删了** | **415** |
| GET / DELETE | **200 删了** | **405** |
| 80 KB body | **200 收下了** | **413** |
| 坏 JSON | **200** | **400** |
| `sessionId: 42` | **200** | **400** |
| 合法 UI 请求 | 200 | **200（功能不回归）** |

---

## 六、尚未覆盖（按 Pi 的 R4/R5/R6 剩余项）

这几条**必须在服务层测**，而服务层还没迁进容器，所以本报告不含：

- **R4**：只删"已归档且非 live"的会话；删除前重新读持久状态；防重放（一次性 nonce）；重复删返回 404/409 而非 500。
- **R5**：先删文件再清状态；文件失败时归档状态不变；建议先原子 rename 到 `storages/archive-trash/<id>`。
- **R6 剩余**：限流（每 IP/会话）、审计日志（id/结果/时间，不含内容）。

顺序：服务层 + R4/R5 → 安全挂载（`ctx.inject`）→ 客户端 UI。

---

## 七、一句话

> 旧路由是"谁发 POST 谁就能删"，新守卫是"只有本机、同源、带自定义头、64 KB 以内的 JSON 请求，且 id 形状合法，才有资格到达服务层"。
> 而**能不能删这个会话**，仍然由服务层按 R4/R5 另行决定——两道闸门，互不替代。
