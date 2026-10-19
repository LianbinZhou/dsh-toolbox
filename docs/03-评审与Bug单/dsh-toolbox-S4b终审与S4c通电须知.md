# dsh-toolbox · S4-b 终审意见 + S4-c 通电须知

> 结论：**S4-b 的 P0/核心状态机可以 PASS；但只能盖“单 host 实例”章，不能盖“跨实例并发安全”章。**
> S4-c 可以启动，但真实 typert/RPC 绑定是另一个量级的工程，必须先读官方 codegen，不要手写“看起来像”的 binding。

---

## 一、S4-b 终审

### 我核到的

- `npm test`：**264 pass / 0 fail / 0 skip**（我实跑）。
- 报告里的 P0：
  - journal 损坏 → fail closed；
  - `done` 记录剪枝；
  - protected 容量上限 + `trash-full`；
  - 顶层 junction 拒绝；
  - `heal` adoption 加锁；
  - nonce 形状；
  - `finish` 对 ENOENT 幂等；
  - 双拼写清理 + list 去重；
  - audit 0600、rotation 失败 truncate、writer 截断；
  - RPC actor/id 两个有界 Map、list/heal 限流、rows 500、gateway 不信 body principal。
- `prepack` 改为只构建；`npm pack` 根因是 prepack 跑了 flaky 网络测试，修法合理。

### 仍需在 S4-c/生产前盯住的一条 P1

**journal 跨实例写没有文件锁。** 报告自己标了 `⚠️`：

- 唯一 temp 名只防“互相覆盖写坏”，**不防丢失更新**；
- 两个 service 实例（HMR/双 host）同时 read-modify-write 整文件，后写覆盖先写；
- 丢掉的 claim 可能让 trash 条目变成“无 journal 孤儿”，TTL 后被 GC 删除。

如果生产保证**只有一个 host service 实例**，S4-b 可以 PASS；否则在通电前补：

- 文件锁（lockfile/`O_EXCL`）或单写者队列；
- 或 journal 改为 append-only WAL + 定期 compact；
- 测试两个真实 `createFileJournal` 实例并发 delete 不同 id，断言不丢 entry。

**P2 未闭合**（不阻断 S4-b，但别忘）：
- audit 定时 flush 未做（最后一个窗口的拒绝可能丢）；
- `readAudit` 仍整文件读；
- `prepack` 不跑测试，发布前需要 CI 单独跑全量。

**S4-b 盖章建议：**
> **PASS（单实例）**。如果产品/运行时可能出现两个 host service 同时操作同一个 `$DSH_HOME`，则把“journal 文件锁”列为 S4-c 的 P0 前置。

---

## 二、S4-c：真实 typert / `ctx.remote` 绑定须知

### 1. 不要手写 `ctx.remote.archive`

DSH 的 `ctx.remote.<ns>` 是 **typert codegen** 产物：

- host 侧：`Service` + `@Remote()` 装饰的方法，导出 `./typert`（host 描述）；
- client 侧：生成的 `./remote` / `typert.remote-client`，客户端通过 `inject` 拿到 namespace；
- 官方包会带 `lib/typert.host.js`、`lib/typert.remote-client.js`、`.d.ts`。

**如果 Harness 硬写一个“看起来像”的对象，就是假通电。** 必须从：
`dsh-api-settings-controller` / `dsh-api-session-controller` 等官方包反推真实结构，
或直接使用它们的生成工具/模板。

### 2. Service 形态与生命周期

- host 侧应是一个 Cordis `Service`（官方常用 `TypertRemoteService`），`super(ctx, 'archive')`；
- `static inject = ['storageDomain', 'workspaceRegistry', 'sessionPersistence']`；
- `apply`/构造函数里注册；**不要混用** `export function apply` 与 Service 类；
- `Remote()` 方法在 service 实例上；dispose/HMR 时方法表随 fiber 撤销；
- 客户端在 service 未激活时 `ctx.remote.archive` 不存在 → UI 必须 fail closed，显示“归档服务不可用”，而不是一直转圈。

### 3. 身份 / principal

- 真实 gateway 的身份来自**已认证连接**，不是请求 body；
- 不要在 Remote 方法签名里接受 `principal`/`role`/`local`；这些必须由 gateway/ctx 注入或查连接；
- 方法级授权：本地 UI / 远程配对设备 / 其他插件 / agent 分别是什么权限，要写死并测试；
- `list` 可能暴露全部 archived id，远程低权限应拒绝或过滤；
- 审计的 actor 必须来自 gateway 身份，不能是客户端自报。

### 4. 上下文是“连接/会话”，不是 HTTP request

- Remote 方法没有 `req/res`；不要试图从 HTTP header 拿 Origin/token；
- 需要会话/工作区上下文时，从 `ctx`/session/agent 拿；
- 取消/abort：客户端断开、用户取消、gateway timeout 时，service 必须把删除做成**幂等 claim/trash 状态**，不能因为调用方消失留下半状态；
- 长删除不要阻塞 RPC 直到超时；考虑返回 job id + 状态查询，或至少让客户端重试安全。

### 5. 异常与序列化

- 用 `RemoteError`/稳定错误码；不要 throw 原始 `Error`（路径/堆栈会过 wire）；
- 每个 Remote 方法的入参/返回值要有 schema（zod/typert）；`sessionId`、`rows`、`warning` 都要限长；
- 不要返回 `Date`/`BigInt`/函数/`undefined`；用 ISO string/JSON；
- `list` 的 rows 上限（已有 500）在 Remote 层再确认；客户端不要一次拉全量。

### 6. 依赖解析（S4-c 最大坑）

profile 安装的 bundle **解析不到 harness 安装目录内部的包**。  
`@deepseek-ai/dsh-typert-protocol`、生成的 remote client、`dsh-workspace` 等都可能踩这个坑。

- 优先使用宿主已提供的服务/生成产物；
- 如果必须 import，先验证 profile 的 Node 解析路径；
- 不要用“本地软链能跑”证明发布包能跑；必须在 `npm pack` + 临时 profile 安装后测。

### 7. codegen 版本与构建

- 生成的 host/remote 文件由 DSH 版本决定，**不要手改**；
- host 与 client 的 typert 版本必须匹配；升级 DSH 后重新生成；
- 生成文件要提交/可复现；`npm pack` 必须包含 `lib/typert.*` 和 `.d.ts`；
- 客户端 `inject` 的 namespace 名称/版本不能猜。

### 8. 真实测试清单

- 真实 DSH host + 真实 client（不是 `createArchiveGateway` 直接调）；
- 未认证/远程/其他插件/agent 调 `archive.delete` → 拒绝；
- 正常 UI 调 → 成功；`list`/`heal` 限流；
- 客户端取消/超时/断线 → service 状态可恢复、不重复删除；
- service dispose/HMR → client 调用得到稳定错误，不崩溃；
- `npm pack` 安装到干净 profile → `ctx.remote.archive` 真实存在；
- 版本不匹配 → 明确失败，不静默降级。

### 9. 不要退回 HTTP

RPC 已经消掉“新增未认证端点”；S4-c 不要为了调试再挂 `webServer` delete 路由。  
如果临时启用 HTTP 备胎，必须保持 `enabled:false` 默认，并继续 token/origin/代理头检查。

---

## 三、最终建议

- **S4-b：PASS（单实例）**；跨实例 journal 锁列为 S4-c/生产前置 P0。
- **S4-c：可以启动**，但先做“官方 typert 结构侦察 + 真实 host/client 最小 echo”再写 archive 绑定；不要直接猜 `ctx.remote.archive`。
- 通电前必须看到：干净 profile 安装、真实 gateway 身份注入、取消/超时、HMR、依赖解析、0 skip 全量。
