# S4-b · R4 / R5 服务层报告（删除状态机）

> 日期：2026-10-17
> 对象：`src/host/features/archive/service.js`（新状态机）
> 对照：`test/fixtures/legacy-archive-service.mjs`（迁移前算法复刻）
> 复现：`node tools/prove-service-red.mjs`（打旧算法，应红 6）；`npm test`（打新状态机，应全绿）
> 结论：**六个杀手全部先红后绿**；R5-12 的 trash 机制**没有实现**，改用 tombstone + cleanup-only，理由见第五节。

---

## 一、旧的删除算法（被告）

`dsh-archive-manager` 迁移前的顺序：

```js
check archived → findDir → removeDir → unarchive → workspace → cache
```

四处硬伤（都在算法里，不在服务管道里）：

1. **没有 live 检查**——正在运行的会话照样能被删；
2. **检查与使用之间有间隙**——`findDir` 之后到 `removeDir` 之前不做二次确认，期间被 unarchive 或变 live 都不会被发现；
3. **没有 per-id 锁**——并发两次删除会两次进入 `removeDir`；
4. **文件先删、状态后清，失败只记 warning**——一旦 unarchive 失败，就进入
   「文件没了、归档标记还在、`findDir` 永远返回 undefined」的**死局**，用户再无任何 API 能清掉这条标记。

第 4 条是 Pi 清单里最刁的一条，也是我这次设计的重心。

---

## 二、红灯（打旧算法）

`node tools/prove-service-red.mjs` 实际输出：

```
[RED] R4-1  a LIVE session is refused, and nothing is touched
            -> a running session must not be deleted (true !== false)
[RED] R4-2  an unarchive that lands between find and remove cancels the delete
            -> the archived set must be re-read before rm
[RED] R4-3  a session that becomes LIVE between find and remove is refused
            -> live must be re-checked right before removing
[RED] R4-4  a replayed delete is 409/404 and runs the side effects once
            -> the second answer needs a stable reason, got {"ok":false,"error":"not archived"}
[RED] R4-5  two concurrent deletes of the same id: one wins, one is refused
            -> exactly one delete may win, got 2
[RED] R5-1  rm succeeded but unarchive failed: a retry must be able to finish
            -> a retry must finish the cleanup (idempotent cleanup-only)
[GREEN] R5-2  unarchive succeeded but workspace cleanup failed: a retry heals it
[GREEN] R5-9  sibling sessions in the same project survive

total: 8   RED: 6   GREEN: 2
```

`R4-5` 的 `got 2` 尤其说明问题：两个并发请求**都成功删除**了。

---

## 三、新状态机的七条不变式

| # | 不变式 | 对应杀手 | 实现位置 |
|---|---|---|---|
| 1 | **per-id 锁**；不同 id 互不阻塞 | R4-5 | `withLock` + `locks: Map<id, tail>` |
| 2 | 破坏性操作**之前**重新读 archived **和** live | R4-2 / R4-3 | `beforeStep('rm')` 之后的两道 fresh 判定 |
| 3 | **先删文件，再清状态**；删文件失败时所有标记不动 | R5 顺序 | `removeDir` 失败 → 立即返回 `remove-failed` |
| 4 | bookkeeping 失败进 `pendingCleanup`，`heal()`（`list()` 也调用）自动重试 | R5-2 / R5-10 | `cleanup()` + `heal()` |
| 5 | `已归档 + 目录不存在` → **cleanup-only**：清标记并报成功 | **R5-1** | `findDir === undefined` 分支 |
| 6 | 每个拒绝带**稳定机器码**（`status` + `reason`），不透传异常文本 | R4-4 / R4-12 | `REASONS` 常量 |
| 7 | 锁在依赖抛错时**必然释放** | R5-13 | `try/finally` + `release()` |

稳定机器码清单：

```
invalid-id · not-archived · session-is-live · session-became-live
no-longer-archived · dir-missing · remove-failed · cleanup-only · already-deleted
```

---

## 四、绿灯与证据

```
服务矩阵（新状态机）   13 / 13 绿
服务矩阵（旧算法）      8 项 → 6 红        ← 反向证据
存储矩阵（旧 guard）   27 项 → 14 红       ← 反向证据
攻击矩阵（旧路由）     16 项 → 14 红       ← 反向证据
全量                  185 项 → 183 绿 + 2 跳过（Playwright 未安装）
```

新增的 5 条非矩阵测试（`test/archive-service.test.mjs`）：

- `invalid-id` 在读 archived **之前**就被拒（依赖调用计数 = 0）；
- 独立 id 不被暂停的 id 阻塞（用 deferred 门，不靠 `Promise.all` 的偶然顺序）；
- `removeDir` 抛 `EBUSY` 后：标记保留、锁释放、第二次仍能进入（`attempts === 2`）；
- `heal()` 幂等，空集也安全；
- 所有 reason 都是 `^[a-z-]+$` 的码，不是英文句子。

---

## 五、**没有**做的部分（诚实清单）

### 5.1 R5-12 的 trash/quarantine 没有实现

Pi 推荐「先原子 rename 到 `$DSH_HOME/storages/archive-trash/<id>.<nonce>`，再慢慢清」。
**我选了另一条路**（tombstone + cleanup-only + heal），理由与代价如下：

- 理由：`rmSync` 已经是原子的"删除这个目录"，rename 到同卷 trash 并**不能**让失败变得可恢复
  （rename 失败同样会留下半状态），而它引入了一个新的持久目录、一条新的清理路径、以及
  「trash 里的东西什么时候删」这个新问题。我用 `pendingCleanup` + `cleanup-only` 覆盖了
  Pi 清单里 trash 想解决的三个场景（rm 后 unarchive 失败、workspace 失败、目录早已不存在）。
- 代价（必须说清）：**「文件已删但 bookkeeping 未清」期间，会话文件是不可恢复的**；
  trash 方案在那个窗口里还能 restore。要做到真可恢复，必须加 trash。**这条我承认是降级，不是等价。**
- 如果要补：在 `removeDir` 前加 `renameDir(dir, trashPath)`，把 `removeDir` 换成 `trash`，
  `cleanup` 成功后再 `rm trash`；`heal()` 里对残留 trash 做「有标记则清、无标记则 restore」。

### 5.2 R5-11 崩溃矩阵只覆盖了一半

已覆盖：`rm 完成后 unarchive 失败`（重试可清理）、`unarchive 完成后 workspace 失败`（`heal()` 可清）。
未覆盖：`find 后 rm 前`、`rm 一半`、`workspace 后 cache 前`、`全部完成响应前` 的进程重启语义。
这些需要「重建 service 实例 → 调 list/delete」的重启模拟，尚未写。

### 5.3 其余未覆盖项

| ID | 状态 |
|---|---|
| R4-7 durable 优先于内存快照 | 未测（当前 `readArchived` 由调用方提供，语义取决于注入实现） |
| R4-8 archive 集合里的脏元素（`null` / `{}` / `42`） | 未测 |
| R4-9 bare / `session-` 双拼写重复 | 未测 |
| R4-10 真实历史 id 兼容（非 UUID） | **已用真实数据验证通过**（见 5.4） |
| R4-13 confirm nonce | **没有实现**，明确"不需要"，不假装有 |
| R5-3 rm 部分删除 | 未测（`removeDir` 是注入的，测试可用"删一半再抛"模拟） |
| R5-4 / R5-5 / R5-6 嵌套 / 项目级 junction、TOCTOU | `paths` 层已测顶层 junction 与 root 内 junction；**嵌套与项目级未测** |
| R5-14 只读目录 / EBUSY / 长路径 / 中文项目名 | 未测 |
| P1-4 Playwright 浏览器 CORS | **仍是 skip**（本机未安装） |

### 5.4 `R4-10` 已在真实数据上验证（不再是风险）

之前我写的是"没查，是风险"。已经查了，**结果干净**：

```
真实 C:\Users\zhou0\.dsh\sessions 下：
  会话目录总数          100
  不符合 allowlist 的    0
  形态分布：session-<uuid> 86  ·  <uuid> 14
```

allowlist 是 `/^(?:session-)?[0-9a-fA-F][0-9a-fA-F-]{7,63}$/`，
两种真实拼写都接受，**没有任何历史 id 会因为形状不合法而被锁在门外**。

⚠️ 但这条只证明了「本机当前的 100 个目录」。DSH 若将来引入第三种拼写，
allowlist 会静默把它挡掉，表现为「这个会话删不掉」。建议在 `list` 里对
「已归档但 allowlist 不通过」的 id 单独告警，而不是静默过滤——这条**未做**。

---

## 六、尚未接线

`registerArchiveRoutes({ webServer, token, origins, onDelete })` 已实现并有 P1-6 集成测试
（fake `webServer` 捕获 route → 真实 HTTP 打它 → 无凭证 401 且 `onDelete` 未执行；未配 token/origins 时不注册）。

**但它还没有挂到真宿主**，剩余三件事：

1. 宿主 feature：组装 `paths` + `service` + `registerArchiveRoutes`，`origins` 取自 webServer 的真实监听地址；
2. `ctx.inject([...], cb)` 可选挂载：缺任一服务只关归档，绝不拖死工具箱（主 `inject` 保持 `['tools']`）；
3. token 交付通道：必须走同源已认证通道，不写 URL、不写日志、不写页面常量。

---

## 七、一句话

> 旧算法把「删文件」和「清状态」做成了一条没有退路的直线，中间任何一步失败都会留下不可清理的残骸。
> 新状态机把它拆成「有锁、有二次确认、失败可重试、残骸可清理」四件事——**但它选择了墓碑而不是回收站，所以那个失败窗口里文件不可恢复**。这一点请在放行前确认是否接受。
