# dsh-toolbox · Audit 日志“塞满硬盘”评审

> 对象：`src/host/features/archive/audit.js` + `rpc.js` 的审计调用
> 结论：**能塞满，而且不止一种方式。** 当前设计把“审计”放在了鉴权/限流之前，且文件无上限、无轮转、无字段截断。
> 在它接真实 gateway 前必须修，否则一个未认证/低权限客户端就能把磁盘写满、把内存打爆。

---

## 1. 攻击面（按杀伤力）

| # | 攻击 | 现状 | 后果 |
|---|---|---|---|
| A1 | **未认证 + 非法 id 刷审计** | `rpc.delete(principal, sessionId)` 在 `isSafeSessionId` 失败时**先 `record`**，再返回；`call()` 的 auth 根本没走到 | 任意 gateway 调用者可无限写 `invalid-id` 行，无需登录 |
| A2 | **未认证 / forbidden 调用刷审计** | `call()` 对 `!principal`、`!allowed` 都 `record` 一行；审计在拒绝之前 | 没有凭证也能无限写 `unauthenticated/forbidden` |
| A3 | **rate-limited 之后继续刷** | `withinLimit` 拒绝时仍 `record` 一行；攻击者可以故意打满限额后继续请求 | 限流反而变成“每条拒绝都写日志”的放大器 |
| A4 | **`list` / `heal` 没有限流** | `withinLimit` 只在 `id !== undefined` 时调用；`list/heal` 无 id、无限流 | 已认证 UI 可无限刷 list/heal，每条写审计 + 消耗 CPU |
| A5 | **文件无上限、无轮转** | `appendFileSync` 直接追加；没有 size cap / rotation / retention | 单文件无限增长，最终 ENOSPC |
| A6 | **字段无截断** | `pick()` 只挑字段，不截断 `actor/source/role/reason`；`invalid-id` 分支的 `actor: principal.id` 未 slice | 一条记录可以是几 MB，放大磁盘消耗 |
| A7 | **`hits` Map 无上限** | 每个 valid id 一个 `id:` key，永不清扫 | 攻击者用大量唯一 UUID 打 `delete` → 内存涨到 OOM（即使 id 不存在） |
| A8 | **`readAudit` 整文件读入内存** | `readFileSync(file,'utf8')` 全量 | 日志被塞大后，读日志的进程直接 OOM |
| A9 | **同步 append 阻塞事件循环** | `appendFileSync` 每条一次 | 高频审计把 DSH 卡住；与 A1–A4 组合就是 DoS |
| A10 | **审计文件权限/软链** | `mkdirSync` 默认、`appendFileSync` 跟随软链 | 同机其他用户可读；本地攻击者可把审计写到别处 |
| A11 | **principal 可伪造** | `createArchiveGateway` 直接使用 `request.principal` | 任何调用者传 `{role:'ui',local:true}` 就通过；审计里的 actor 也是假的 |
| A12 | **审计失败静默** | `appendFileSync` catch 后不告警、不 fallback | 磁盘满时审计静默丢失，之后无法追责 |

---

## 2. 最小修法（按顺序）

### 2.1 先限流，再审计

- **所有方法**（delete/restore/list/heal）先过 **per-actor 全局窗口**，无 id 也要限。
- 非法 id / 无 principal / forbidden / rate-limited 的请求：
  - **不要每条写一行**；按 actor/source/window 聚合，例如每分钟一条
    `{at, actor, reason:'invalid-id', count: 1234}`；
  - 或者只写内存计数器，定期 flush。
- 审计不能成为“未认证写磁盘”的入口。

### 2.2 审计文件必须有硬上限

```text
audit.jsonl            当前文件，max 5 MB
audit.jsonl.1 ... .5   轮转，保留 N 个
总上限                 例如 30 MB
```

- 超过上限：原子 rename 轮转；最老删除；绝不无限追加。
- 磁盘满/不可写：切到 **有界内存 ring buffer** + 一次可见告警；不要静默。
- `readAudit` 改成**流式/尾部 N 行**，不要整文件读。

### 2.3 字段白名单 + 截断

- `actor/source/role/reason/id` 全部 `String(...).slice(0, 64/128)`；去掉控制字符。
- `actor` 来自 **gateway 认证后的 principal**，不是 request body；`createArchiveGateway` 现在是模拟器，不能当生产。
- 禁止把 `principal.id` 直接写进 audit 而不截断（A6）。

### 2.4 `hits` 也要防 OOM

- 每个 id 的窗口记录要做 **LRU/定期清扫**；
- 设 `hits` 最大 key 数（例如 10k），超过就拒绝/降级；
- 或者用固定大小 ring，不按 id 无限建 key。

### 2.5 文件权限/位置

- 目录 `0700`，文件 `0600`；`lstat` 拒绝软链（或 `O_NOFOLLOW`）。
- 放在 `$DSH_HOME/storages/` 下，不走任何 HTTP 静态目录。
- 不记录 token、路径、草稿内容、异常原文；`warning` 只记 `'yes'`。

### 2.6 真实 gateway 的 principal

- `createArchiveGateway` 的 `request.principal` 只是测试桩；真实实现必须从 **DSH 已认证连接**取 principal，不能由请求参数传。
- 测试：伪造 `{role:'ui', local:true}` 的 gateway 请求必须 403；审计 actor 必须是连接身份。

---

## 3. 必测矩阵（防塞满）

| ID | 测试 | 期望 |
|---|---|---|
| A-1 | 未认证 + 10,000 个非法 id | 审计文件 ≤ 上限；不 OOM；delete 不被阻塞 |
| A-2 | 10,000 个 forbidden 调用 | 同上；按窗口聚合，不是 10k 行 |
| A-3 | 打满 per-actor 限额后继续 10,000 次 | rate-limited 日志有界/聚合；磁盘不爆 |
| A-4 | list/heal 高频 | 有限流；审计有界 |
| A-5 | 10,000 个唯一 valid UUID delete（均 not-archived） | `hits` Map 有界；内存不涨到 OOM |
| A-6 | `actor/source/reason` 传 1 MB 字符串 | 单行截断到上限；文件不放大 |
| A-7 | 审计文件写到只读/磁盘满 | delete 仍成功；有告警/ring buffer；无递归审计 |
| A-8 | 审计轮转与并发写 | 不丢行、不产生半行；旧文件按 retention 删除 |
| A-9 | `readAudit` 读 30 MB 文件 | 流式/限量；不 OOM |
| A-10 | 审计文件是软链 | 拒绝/不跟随 |
| A-11 | 伪造 `request.principal` | 403；audit 不信任伪造 actor |
| A-12 | 24h/百万条 soak | 文件大小稳定；内存稳定；事件循环不卡 |

---

## 4. 一句话

**审计日志是“安全设施”，不是“攻击者的磁盘写入原语”。**
先鉴权/限流/聚合，再写日志；日志自身必须有硬上限、轮转、字段截断、流式读取和失败降级。
现在这版一旦接真实 gateway，A1+A3+A5 就能在未认证/低权限状态下把磁盘或内存打满。
