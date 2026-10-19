# dsh-toolbox S4-b · R4 / R5 刁钻测试清单

> 用途：R0 是“门卫”，R4/R5 是“仓库管理员”。
> 门卫过了，不代表管理员不会把不该删的删了、或者删一半留下鬼状态。
> 这份清单按“能真正造成数据损失 / 幽灵会话 / 卡死不可重试”排序。

---

## 0. 测试地基（先搭好，不然测不出来）

1. **真实临时 `DSH_HOME`**：`mkdtemp`，绝不碰 `~/.dsh`。
2. 真实文件树：
   - `<home>/sessions/<projectA>/<session-1>`
   - `<home>/sessions/<projectA>/<session-2>`（同项目另一个会话）
   - `<home>/sessions/<projectB>/<session-3>`
   - `<home>/storages/session_projcache.json`
   - `<home>/storages/session_projcache/sessions/<id>.json`
3. Fake `storageDomain`：
   - 可变的 `archivedSessionIds`；
   - 可注入 `get()` 抛错/返回旧快照；
   - 可记录写入次数。
4. Fake `workspaceRegistry` / workspace rows：
   - 至少两条 row，其中一条指向被删会话，另一条必须保留。
5. Fake live 状态：
   - `sessionPersistence` / `sessionQuery` 返回 `live: true` 的会话；不要只信 archived set。
6. **依赖注入**（迁移时必须做，否则 R5 的失败点无法测）：
   ```js
   createArchiveService({
     findDir, removeDir, unarchive, dropWorkspaceRows, scrubCache,
     isLive, now, locks,
   })
   ```
   每个依赖都可以在测试里替换为“抛错 / 延迟 / barrier / 计数”。
7. **步骤钩子**：在 `check → resolve → remove → unarchive → workspace → cache → respond`
   每一步前后都能 `await barrier()` / 注入失败。

---

## 1. R4：只删“已归档且非 live”，防重放/并发

> 旧 `ArchiveManagerService.delete()` 的顺序是：检查 archived → find → rm → unarchive → workspace → cache。
> 它没有 per-id 锁，也没有在 rm 前重新读 archived/live；下面这些在旧实现上应有红灯。

### R4-1（最高）删一个 live 的 archived 会话

- 预置：id 在 `archivedSessionIds` 里，同时 `isLive(id) === true`（会话正在跑/正在被当前 agent 使用）。
- 调用：`delete(id)`。
- 期望：**拒绝**，返回 409/403；文件、archive、workspace 全部不变。
- 旧实现：没有 live 检查 → 直接删；红。

### R4-2（最高）find 之后、rm 之前，会话被 unarchive

用 barrier：

1. `findDir` 返回后暂停；
2. 另一个调用 `unarchive(id)`（或直接把 archived set 改为不含 id）；
3. 放行 delete。

期望：delete 在 rm 前**重新读** archived set，发现不再归档 → 拒绝；文件仍在。
旧实现：检查一次就删 → 红。这是“检查/使用间隙”的经典数据损失。

### R4-3（最高）find 之后、rm 之前，会话变 live

1. `findDir` 后暂停；
2. 另一个调用把会话标记为 live（用户打开/恢复会话）；
3. 放行。

期望：拒绝，文件/archive 不变。
旧实现：没有 live 检查 → 红。

### R4-4 同一 id 连续两次 delete（重放）

- 第一次成功；第二次立即调用。
- 期望：第二次 404/409；`removeDir` / `unarchive` / `workspace` 都只执行一次；不是 500。
- 旧实现：第二次可能报“找不到目录/只能删除已归档”，状态码不统一；如果第一次 unarchive 失败，第二次会卡在“找不到目录”；红/半红。

### R4-5 两个 delete 并发（same id）

- 同时发两次；用 barrier 让两个都通过 initial check。
- 期望：per-id 锁 → 一个成功，一个 409；`removeDir` 计数 1；archive 清理 1；没有第二次 200。
- 旧实现：两个都可能进入 rm（一个成功一个 ENOENT），返回 500/400；红。

### R4-6 delete 与 unarchive 并发

- 同时 `delete(id)` 和 `unarchive(id)`。
- 允许两种确定性结果：
  - unarchive 先拿到锁 → delete 看到未归档 → 拒绝，文件保留；
  - delete 先拿到锁 → unarchive 返回 409/无操作，最终文件删除、archive 清除。
- 不允许：文件删了但 archive 仍是 archived，或 unarchive 成功但文件被删。
- 旧实现：无锁 → 可能产生半状态；红。

### R4-7 archived set 只在内存里，durable 没有

- fake `domain.global.get()` 返回 archived，但 durable 层/workspace.json 不含该 id。
- 期望：以 durable 为准；拒绝删除或先修复；不能凭内存快照删文件。
- 旧实现：直接用 `domain.global.get()`；红（取决于真实数据）。

### R4-8 archived set 里有脏元素

- `archivedSessionIds = [null, {}, 42, 'session-valid']`。
- 期望：不崩；`String(id)` 后只匹配合法 id；null/对象不导致误删；合法 id 正常。
- 旧实现：`canonicalSessionId(String(id))` 可能把 `"null"` 当 id；如果没有目录就跳过；要测。

### R4-9 bare / `session-` 双拼写重复

- archived set 同时有 `abc-uuid` 和 `session-abc-uuid`；目录只有一份。
- 期望：只删一次；只清理一份 archive；第二次 404/409。
- 旧实现：canonical 可能去重不彻底；测。

### R4-10 真实旧 id / 非 UUID 兼容

- 从真实 `~/.dsh/sessions` 找一条**最老的 session id**（可能是非标准拼写）。
- 期望：R3 的 allowlist 不能把真实旧 id 挡在门外；否则用户无法删除旧归档。
- 如果 allowlist 只接受 UUID，必须确认 DSH 历史 id 全是 UUID；否则放宽为“真实 id 字符集 allowlist”，而不是 UUID-only。
- 这是 R3 与 R4 的交叉点，必须用真实数据测，不要只用测试 fixture。

### R4-11 route 层 200 但 service `ok:false`

- service 返回 `{ok:false, error:'not archived'}`。
- 期望：route 不能 200；应 409/404，且 UI 显示拒绝原因。
- 旧 route：`body.ok===false` 已映射 409（当前 WIP 对）；补集成测试。

### R4-12 客户端丢了 200 后重试

- 模拟第一次删除成功但客户端没收到响应；重试。
- 期望：第二次 404/409，且不产生第二次文件删除/第二次 archive 写入；UI 可认为已删除。
- 旧实现：第二次可能“找不到目录”报错，用户看到失败但实际已删；红（UX/状态）。

### R4-13 confirm nonce（如果实现）

- 同一 nonce 重放 → 409；
- nonce 用于另一个 id → 409；
- 过期 nonce → 409；
- nonce 不写 URL/日志；不在响应回显。
- 没有 nonce 就明确“不需要”，不要假装有。

---

## 2. R5：顺序、部分失败、崩溃恢复

> 当前旧实现：**先删文件，再 unarchive/workspace/cache；失败只给 warning**。
> 这意味着“文件已删但 archive 还在”或“archive 已清但 workspace 还在”的半状态。
> 下面每个失败点都要单独测。

### R5-1（最高）rm 成功，unarchive 失败 → 第二次 delete 卡死

1. 注入 `unarchive` 抛错；
2. 第一次 delete：文件被删，archive 仍在，返回 200 + warning；
3. 第二次 delete：`findDir` 找不到目录 → 当前返回 `ok:false`，**archive 永远清不掉**。

期望：第二次应该能执行 **idempotent cleanup**：既然 archived 且目录不存在，允许清理 archive/workspace/cache，返回成功或“已删除，已修复”。
或者用 trash/quarantine，第一次不进入“文件已删但状态未清”的不可恢复态。
旧实现：卡死；红。这是 R5 最刁的一条。

### R5-2（最高）unarchive 成功，workspace 清理失败 → 重试被“未归档”拒绝

1. 注入 `_dropWorkspaceRows` 抛错；
2. 第一次：文件删除、archive 清除、workspace 行残留，返回 200 + warning；
3. 第二次：已不在 archived → 拒绝删除，workspace 幽灵行永远在。

期望：要么在 list/启动时自愈 workspace 行；要么保留一个“deleted” tombstone 让 cleanup 可重试。
旧实现：红。

### R5-3 rm 部分删除后抛错

- 用依赖注入让 `removeDir` 先删掉 session 里一个文件，再抛 `EPERM/EBUSY`。
- 期望：archive 保持不变；剩余文件可重试；不能把“部分删除”报告成“成功”。
- 旧实现：`rmSync` 可能部分删除；出错直接返回 `ok:false`；archive 不变（对），但部分文件需要可重试；测。

### R5-4 嵌套 junction / symlink 指向外部

- session 目录**内部**放一个 junction 指向 `<home>/outside`；
- `rm -r session`。
- 期望：只删 session 和 junction 本身；外部 marker 存活。
- Node `rmSync` 通常不跟随 junction；但必须用真实 Windows junction 测，不能靠假设。
- 旧 R2 只测顶层 junction，没测嵌套；补。

### R5-5 项目目录是 junction 到外部

- `<sessions>/<project>` 是指向外部的 junction。
- `findSessionDir` 应拒绝（realpath 外部）；`removeSessionDir` 不应删外部。
- 旧 paths 可能 `readdir` 跟随；R2 未覆盖 project 级 junction；补。

### R5-6 find 之后，session 目录被换成 junction

- barrier：`findDir` 返回后，把真实目录 rename 走，换成指向另一个 session/外部的 junction；
- 放行 rm。
- 期望：`removeSessionDir` 重新 `lstat` 拒绝；目标 session/外部存活。
- 这是 R2 的 TOCTOU 服务层版；旧实现可能删到目标；红。

### R5-7 archived id 一开始就没有目录

- archive 有 id，目录不存在。
- 期望：明确 404/409 “目录不存在，归档状态未改”；**不能静默成功**；如果提供 cleanup-only，必须单独确认。
- 旧实现：`ok:false` “找不到”；但 archive 仍卡；如果用户只想清 archive，没有路径；R5-1 相关。

### R5-8 session 路径是普通文件

- `findSessionDir` 只返回目录；如果测试直接 `removeSessionDir(file)`，必须拒绝（R2c 已有）；服务层如果遇到 file，应拒绝，archive 不变。

### R5-9 同项目其他会话必须存活

- projectA 有 session-1/2；删 1。
- 期望：session-2、projectA、其他 projectB 完好；workspace 只动 1 的行；cache 只动 1 的 key。

### R5-10 cache 清理失败

- `scrubCache` 抛错；文件/archive/workspace 已成功。
- 期望：返回 warning，不把整个删除报告成失败；cache 是 cosmetic；list 不崩。
- 旧实现：warning；但第二次 delete 已不可用；需要 self-heal。

### R5-11 崩溃点矩阵（进程重启）

对每个点，模拟“服务重新构造/进程重启”，再调用 list/delete：

| 崩溃点 | 重启后必须满足 |
|---|---|
| find 后、rm 前 | 会话完整，archive 仍 archived；可重试 |
| rm 一半 | archive 仍 archived；剩余文件可重试；不能显示“已删” |
| rm 完成、unarchive 前 | archive 仍 archived；重试必须能清 archive（R5-1） |
| unarchive 后、workspace 前 | archive 已清；workspace 行必须自愈/可清理 |
| workspace 后、cache 前 | 文件/archive/workspace 一致；cache 可清 |
| 全部完成、响应前 | 重试 404/409；不重复删 |

### R5-12 无回滚时的“可恢复”设计

如果没有 trash/quarantine，至少要有：

- `archived && dir missing` → 允许 cleanup-only；
- `!archived && dir missing && workspace row exists` → list/启动自愈 workspace；
- 响应携带 `warning`，UI 显示“部分完成”；
- 重试不会 500，不会二次删。

**更推荐**：先原子 rename 到 `$DSH_HOME/storages/archive-trash/<id>.<nonce>`（同卷），再清 bookkeeping，最后删 trash；失败可 restore/retry。测试：
- rename 失败 → 无变化；
- rename 成功、unarchive 失败 → trash 可恢复，archive 仍 archived；
- rename 成功、workspace 失败 → trash 保留，重试清理；
- trash 删除失败 → warning，不丢主状态。

### R5-13 锁释放

- 在 `removeDir` 抛错、unarchive 抛错、workspace 抛错后，per-id 锁必须释放；
- 下一次 delete 不能永久 409/卡住；
- 独立 id 的 delete 不被同一个锁阻塞。

### R5-14 真实文件系统/权限

- 只读目录、被占用文件（Windows EBUSY/EPERM）、长路径、空格/中文 project 名；
- 失败必须保持 archive 不变，返回可读错误，不泄露绝对路径；
- 修复权限后重试成功。

---

## 3. 测试顺序与判定

1. **先在旧 service 上跑 R4-1/2/3、R5-1/2**，确认红：
   - live 被删；
   - unarchive 竞态被删；
   - rm 后 unarchive/workspace 失败导致第二次卡死。
2. 再写服务层锁 + 状态机/trash，让红转绿。
3. R4-4/5/6 并发测试必须用 **barrier**，不要靠 `Promise.all` 的偶然顺序。
4. 所有测试用临时 `DSH_HOME`；断言失败时打印树，但不要打印真实用户路径。
5. R4/R5 全绿 + R0 全绿 + 路由真实挂载，才允许把 delete 路由接到 `webServer`。

---

## 4. 一句话给 Harness

**R4 的三个杀手：live、unarchive 竞态、重放；R5 的三个杀手：rm 后 unarchive 失败、archive 清后 workspace 失败、部分删除。**
先把这六个写成红测，别先写删除逻辑。
