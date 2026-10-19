# dsh-toolbox · RPC 通道评估 + Trash 放行条件

> 对象：`docs/S4b-token交付通道设计.md`、`src/host/features/archive/rpc.js`、Trash 状态机
> 结论：**RPC 是正确方向，但不是“零攻击面”。**
> 准确说法：**不再新增一个未认证的 HTTP 端点**；攻击面从“你的 route-guard”转移到“DSH 已认证的 RPC 网关 + 方法级授权”。
> Trash 方向可批，但 T9/T10、四个崩溃点、真实 archived 幽灵 ID 未闭合前，不能算完整。

---

## 1. 为什么 RPC 不是“零攻击面”

RPC 仍然走网络（DSH 的 HTTP/WebSocket 网关），只是复用了已有认证，而不是插件自己开端口。

| 面 | 状态 |
|---|---|
| 新增的 `/api/archive-manager/delete` | **应当消失**（不注册 `webServer`）——这是最大收益 |
| CORS / DNS rebinding / `X-Forwarded-*` | 不再适用于这个**新**端点；但 RPC 网关自身仍有连接认证、Origin/Host、token/cookie 的问题 |
| 任意已认证客户端 | **仍可调用** RPC 方法；需要方法级授权，不能只靠“连接已认证” |
| 远程客户端 / 配对设备 | 如果 RPC 方法对它们开放，它们可以删除；需要角色/来源限制 |
| 同源 XSS / 恶意插件客户端 | 同一页面里的任何脚本都能调 `ctx.remote`；认证不区分“哪个插件” |
| 模型 / Agent / MCP | 必须确认删除方法**没有**被暴露成工具或远程 API |
| 本机同用户进程 | 仍能读 DSH 数据/调用通道；这不是网络 token 能解决的 |

**验收话术**：写“**不新增未认证网络端点**”，不要写“零攻击面”。

---

## 2. 当前 `rpc.js` 的具体缺口

`createArchiveRpc` 目前是一个**普通对象 facade**，测试直接 `rpc.delete()`；它没有 `Remote`/gateway 绑定，所以：

| # | 缺口 | 测试/修法 |
|---|---|---|
| RPC-1 | **没有真实 RPC 暴露** | 用 fake `webServer`/gateway 不够；要在真实 DSH remote 绑定下调用；测试未认证/远程/跨源调用 |
| RPC-2 | **没有 actor/authorization** | `delete(sessionId)` 没有调用者参数；remote 端必须传 principal/ctx；按“本地 UI/远程/agent”授权；audit 记 actor |
| RPC-3 | **没有方法级 scope** | 任意已认证客户端都能调；只允许 archive 面板的能力，或明确 remote 角色 |
| RPC-4 | **response 没有白名单** | `rpc.delete` 直接 `return service.delete()`；service 若返回额外字段/路径会透传；`restore/list` 同理。测试 leaky service 返回 `C:\secret` |
| RPC-5 | **`restore` 没 catch** | service 抛错会直接冒到 RPC；应返回稳定 `{status:500, reason:'internal-error'}` + audit |
| RPC-6 | **rate limit 只按 id** | 一个客户端可以删 34 个不同 id；需要 per-actor/全局窗口；`restore` 也要限 |
| RPC-7 | **`list` 暴露全部 archived id** | 远程/低权限客户端不应看到全部；按 actor scope 过滤 |
| RPC-8 | **audit 没有 who/source** | 目前只有 `{at,id,ok,reason,warning}`；R6 要加 actor/source（不记 token/内容） |
| RPC-9 | **“no network import”测试是假安全证明** | `rpc.js` 没有 `node:http` 只说明这个文件不直接开端口；实际 gateway 是网络面。测试必须打真实 RPC 通道 |

**最小可用形态**：

```
Remote method -> principal/ctx -> authorize(action, id, principal)
             -> service.delete(id) -> response whitelist -> audit(actor)
```

`createArchiveRpc` 应该只做 facade；真正的 `Remote` 服务/namespace 必须在宿主 `apply` 里注册，并用真实客户端测。

---

## 3. 真实 RPC 攻击/越权测试

1. **未认证连接**调用 `archive.delete` → 401/拒绝，文件不变。
2. **已认证但不是本地 UI**（远程配对设备/另一个会话）→ 按策略 403；如果允许，必须有显式角色，不能默认。
3. **agent/model 工具**尝试调用 → 不应存在该 tool/remote endpoint。
4. **另一个 client plugin** 调同一 namespace → 记录 actor；若没有隔离，至少审计告警。
5. **同源 XSS / 注入**：无法完全防；用 CSP/禁用 eval/审计，文档写清“同源脚本可删”的边界。
6. **DNS rebinding 页面**：如果 DSH auth token 存在 JS/localStorage/cookie 且可在同源读取，rebinding 后仍能调用 RPC；用真实浏览器/主机名映射测，不能只测 HTTP route。
7. **重放**：同一个 RPC delete 连续/并发；服务层锁 + trash claim 负责，RPC 只做输入/限流/审计。
8. **远程客户端 `list`**：是否应该看到所有 archived id？按权限过滤；测试。

---

## 4. Trash：方向对，但还差 T9/T10 与崩溃矩阵

当前文档自己列出的未闭合项（`S4b-分步交付报告` §6）仍成立：

| 项 | 验收要求 |
|---|---|
| **T9** | trash 秒/TTL/容量/GC/手动 purge；孤儿条目可识别；不能无限增长 |
| **T10** | trash 自身删除时拒绝嵌套 junction/symlink；外部目标存活 |
| **R5-11** | 四个崩溃点（claim 后 rename 前 / rename 后 journal 前 / journal 后 unarchive 前 / unarchive 后 trash 删除前）每个都要“重启后状态 + 恢复动作”测试 |
| **R5-14** | 真实 EACCES/EBUSY/长路径/中文项目名；失败不改 archive |
| **R4-7/8/9/13** | durable 优先、脏 archive 元素、bare/session 双拼写、nonce（如实现） |
| **T7** | bookkeeping 失败保留 trash + heal 的 TTL/策略（保留多久、谁 purge） |

当前 Trash 状态机（claim + journal + same-volume + restore + tri-state + identity）方向对；
但 **T9/T10 没有就不算“完整 Trash”**，只是“可恢复删除”。

---

## 5. 真实 archived ID / 幽灵 ID

“扫 100 个目录”只证明当前目录名兼容；真正的输入是 `archivedSessionIds`。

已有真实数据审计（34 archived ids / 0 invalid / 2 ghosts）是好证据，但必须继续：

1. **幽灵 id**（archived 但无目录）：
   - `probe` 必须是 `absent` 才能 cleanup-only；
   - 不能因为“找不到目录”就 unarchive 一个权限错误/链接；
   - 测试幽灵 id 的 delete、list、restore。
2. **allowlist 不过的 archived id**：
   - 不要静默过滤；`list` 要单独告警“此会话无法删除/形状不识别”；
   - 否则用户会看到“删不掉但没原因”。
3. **双拼写**：bare uuid + `session-uuid` 同时存在时只删一次、只清一次。
4. **durable vs 内存快照**：`readArchived` 必须来自 durable；测试内存过期。

---

## 6. 放行条件

### RPC

- [ ] 不注册任何 `webServer` delete route；`grep` 为空。
- [ ] 真实 `Remote` 绑定 + 真实客户端调用测试；不是直接调 `rpc.delete`。
- [ ] 未认证 / 远程未授权 / agent 调用均拒绝；actor 审计。
- [ ] response/restore/list 全部白名单；leaky service 测不出路径。
- [ ] rate limit per actor + per id；restore 也限。
- [ ] 真实浏览器/DNS rebinding 测试 RPC 通道（不是旧 HTTP route）。
- [ ] 文档把“零攻击面”改成“不新增未认证端点”。

### Trash

- [ ] T1–T10 全绿；T9/T10 不再标“未实现”。
- [ ] 四个崩溃点逐一重启测试。
- [ ] EACCES/EBUSY/长路径/中文项目名。
- [ ] 真实 archived id + 幽灵 id + 双拼写 + durable 优先。
- [ ] `npm ci` 干净环境、`npm pack` 安装后全量测试；Playwright 不 skip。

---

## 7. 一句话

**RPC 把“新增的未认证 HTTP 面”消掉了，这是大胜；但它不是零攻击面，真正要补的是 RPC 方法级授权、真实 gateway 集成测试和响应白名单。**
**Trash 方向对，T9/T10 和四个崩溃点不闭合，就只是“可恢复删除”的半成品。**
