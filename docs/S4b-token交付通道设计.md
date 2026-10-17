# S4-b · token 交付通道设计方案

> 问题：`/api/archive-manager/delete` 现在要求每进程随机 token（32 字节），但**客户端 UI 怎么安全拿到它**？
> 结论：**主方案是"根本不用 HTTP 路由"，走 DSH 已认证的客户端→宿主通道；HTTP + token 只作为第二道防线保留。**
> 状态：设计，未实现（客户端 UI 还没迁进容器）。

---

## 1. 为什么不能"随便给"

先把威胁模型摆清楚，否则方案没有判据。

| 攻击者 | 能做什么 | token 有用吗 |
|---|---|---|
| 局域网内另一台机器 | 直接 POST 到 `:3080` | **有用**（loopback 检查就挡住了，token 是第二层） |
| 用户浏览器里的恶意网页 | 跨源简单请求 / DNS rebinding | **有用**（origin 白名单 + 自定义头预检 + token） |
| 本机另一个**同用户**进程 | 读进程内存、读 `~/.dsh`、读浏览器 profile | **没用**（它本来就能直接删文件） |

**所以 token 的目标是"网络与浏览器侧的一次性凭证"，不是"本机进程隔离"。**
任何"把 token 放进页面可见处"的方案，在 rebinding 场景下都等于没加——因为 rebinding 后的页面同源，
能读到它。这一条决定了下面所有方案的取舍。

---

## 2. 被否掉的三个方案

### ❌ A. 放进 HTML bootstrap（`window.__DSH_TOOLBOX_BOOT__`）

插件无法改写 DSH 的页面 HTML；而且一旦写进页面，任何同源脚本（含 rebinding 后的攻击者页面）都能读到。
**这与 token 的存在目的直接冲突。**

### ❌ B. 加一个 `GET /api/archive-manager/token`

它只能用和 delete 相同的那套检查（loopback + origin + host 白名单）。那么：

- 攻击者若能通过 delete 的门，也就能通过 token 的门，token 退化为**装饰**；
- 若门更松（为了方便前端），更是直接失效。

**循环依赖，否决。**

### ❌ C. 写进 localStorage / Cookie

同样可被同源脚本读取；Cookie 还带 CSRF 语义风险。**否决。**

---

## 3. 主方案：不用 HTTP，走已认证通道

DSH 的客户端插件与宿主之间已经有**一条已认证的通道**（客户端 RPC / `ctx.remote` 一类）。
删除动作完全没必要绕成 HTTP：

```
客户端 UI ──(DSH 已认证的 RPC)──> 宿主 archive service.delete(id)
```

优点：

- **不需要 token**：认证由 DSH 自己做，插件不重复发明；
- **不需要额外开放任何端口/路由**：攻击面直接归零；
- 天然携带会话身份，未来还能按会话做审计与限流（R6 剩余项）。

代价：

- 需要把 `service.delete` 包成宿主侧的一个 RPC handler（而不是 `webServer.register` 的 handler）；
- 客户端 UI 迁移时必须走这条通道，不能图省事 `fetch('/api/...')`。

**这是首选。** 若它成立，`route-guard.js` 里的 HTTP handler 就只是"万一将来必须用 HTTP"的备胎。

---

## 4. 次选方案：HTTP + 运行时下发 token（若必须保留 HTTP）

若最终仍要走 HTTP（例如为了 `curl` 调试或外部工具），那么：

1. **下发通道**：客户端 `apply` 时通过**同一条已认证 RPC** 调 `getArchiveRouteToken()`；
   宿主返回**当前进程**的 token（`createRouteToken()` 生成，内存持有，不落盘、不写日志）。
2. **生命周期**：token 随进程存在；客户端 dispose 时丢弃；宿主重启即换新，旧 token 立即失效。
3. **存放位置**：只在客户端模块内存里（闭包），**不写 localStorage / sessionStorage / URL / DOM 属性**。
4. **使用方式**：每个请求带 `x-dsh-toolbox-token`；服务端逐字节比较（已实现）。
5. **轮换**：进程重启即轮换；可选按小时轮换（需客户端重新 RPC 拿）。

这条路仍然比"不用 HTTP"弱一层：多一个可被网络触达的端点，只是它现在需要一把只有已认证客户端才能拿到的钥匙。

---

## 5. 与现有实现的关系

现有的 `src/host/features/archive/route-guard.js` 已经具备：

- origin 白名单**从真实监听地址推导**（杀 DNS rebinding）；
- 拒绝带 `X-Forwarded-For` 的请求（反代下 loopback 不算认证）；
- 32 字节随机 token，逐字节比较，未配置则 **fail closed**；
- 自定义头强制预检、只收 `application/json`、64 KB 上限、错误脱敏。

也就是说：**换成 RPC 通道时，这些检查全部不需要了；保留 HTTP 时，它们一条都不能少。**

---

## 6. 验收判据（给 Pi）

| # | 判据 |
|---|---|
| 1 | 客户端 UI **不出现** `fetch('/api/archive-manager/...)`（grep 可查） |
| 2 | 若保留 HTTP：token 只能经已认证 RPC 下发，`grep -r "localStorage.*token"` 为空 |
| 3 | 宿主重启后旧 token 立即失效（有测试） |
| 4 | 客户端 dispose 后 token 不再被持有（有测试） |
| 5 | 删除路径的审计日志只记 `id / 结果 / 时间`，不记 token、不记内容 |

---

## 7. 一句话

> token 的价值取决于**谁拿得到它**。放进页面 = 谁都能拿；用一个只有已认证客户端能走的通道下发 = 只挡住网络与浏览器；
> 而**干脆不开 HTTP 端点**，才是这一层唯一真正的"零攻击面"方案。
