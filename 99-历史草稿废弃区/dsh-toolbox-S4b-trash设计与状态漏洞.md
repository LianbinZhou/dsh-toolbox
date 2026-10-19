# dsh-toolbox S4-b · Trash 设计与更狠的数据状态漏洞

> 对象：`src/host/features/archive/service.js`（commit `5d2997b`）+ 拟议的 trash
> 结论：**trash 方向对，但“先 rename 再删”本身不够。** 必须是**持久化状态机 + manifest/journal**，
> 否则会把“文件已删但状态没清”换成“文件在 trash、状态还乱”，只是把坑挪了个位置。
> 另外，当前 service 还有 6 个比 trash 更狠的状态漏洞，建议在引入 trash 前先锁死。

---

## 第一部分：Trash 能不能过关？

### 1.1 能过关的版本（必须全部满足）

| # | 条件 | 原因 |
|---|---|---|
| T1 | **同卷原子 rename**：`stat(trashRoot).dev === stat(sessionsRoot).dev`，否则直接拒绝 | 跨卷 rename 会 EXDEV；退回 copy+delete 就不是原子，崩溃会半删 |
| T2 | trash 根**不在 `sessions` 扫描树里**，或 `findSessionDir` 明确跳过它 | 否则 trash 会被当成 project/session，下一次 delete 可能把 trash 再删一次 |
| T3 | trash 条目名用**随机 nonce**，不用 sessionId 拼路径 | 防路径注入/冲突；manifest 里存 id/originalPath |
| T4 | rename **之前**写 durable claim（`deleting` + id + nonce + dev/ino + revision），写失败就不 rename | 没有 claim，外部 unarchive/live 仍可在 recheck 后抢跑 |
| T5 | rename 成功 → 写 phase `trashed`；bookkeeping 成功 → phase `cleaned`；trash 删除成功 → phase `done` | 崩溃恢复需要每一步可判定 |
| T6 | manifest **原子写**（temp + rename），启动时扫描/恢复 | 内存里的 `pendingCleanup` 重启就没了 |
| T7 | bookkeeping 失败：保留 trash + `trashed`，`heal()` 在 per-id 锁内重试；**不要**因为原目录不存在就 cleanup-only | 否则会出现“已 unarchive 但文件在 trash”的幽灵 |
| T8 | 支持 **restore**：`trashed && 用户 unarchive` → 原路径 rename 回去（原 project 不存在则报错/重建） | 否则用户点“恢复”只清 marker，文件仍在 trash |
| T9 | trash 有 **TTL/容量/GC** 与手动 purge；GC 只删有 manifest 的条目 | 防无限增长；孤儿条目要可识别 |
| T10 | trash 删除自身也必须防 junction/嵌套链接；权限 0700，不通过任何 HTTP 路由暴露 | trash 里可能含不可信链接 |

### 1.2 不建议的“伪 trash”

- `trashRoot` 在 `$DSH_HOME/storages` 但没检查 `dev`：跨卷 rename 失败就 fallback `copy+rm` → **不是原子**。
- 只 rename，不写 manifest：崩溃后不知道 trash 里是什么、属于哪个 id。
- 只把 id 加进内存 pending：进程重启就丢；`list()` heal 不到。
- rename 后立刻 `unarchive`，但 workspace 失败：marker 清了、trash 在、workspace 幽灵；没有 restore/retry。
- 把 trash 放在 `sessions/.trash` 但不从 `findSessionDir` 排除：下一次扫描可能把 trash 当 session。

### 1.3 Trash 相关必测

1. rename 成功、unarchive 失败 → 文件在 trash、archive 仍 archived；重启后 `heal` 能完成；用户可 restore。
2. rename 成功、workspace 失败 → archive 已清、workspace 残留；重启后 `list`/`heal` 清掉。
3. rename 成功、trash 删除失败 → 返回 warning，不丢主状态；重启后可重试。
4. 崩溃点：claim 后 rename 前 / rename 后 manifest 前 / manifest 后 unarchive 前 / unarchive 后 trash 删除前；
   每个点重启后都有确定的恢复结果。
5. 跨卷 `trashRoot` → 拒绝，不 fallback copy+delete。
6. trash 条目名冲突 → 不复用/不覆盖；nonce。
7. trash 根被 symlink/junction 到外部 → 拒绝或解析后仍校验同卷/权限。
8. trash 里嵌套 junction → 删除 trash 时外部目标存活。
9. 用户 unarchive 一个 `trashed` id → 原路径恢复；文件内容完整。
10. 两个 service 实例同时 delete 同 id → durable claim 只能一个成功。

---

## 第二部分：比 trash 更狠的 7 个状态漏洞

> 这些在当前 `service.js` 里已经能看到，trash 不修它们也没用。

### D1（最高）`findDir` 返回 `undefined` 被当成“文件已删”，触发 cleanup-only

当前契约：

```js
findDir: (id) => string | undefined
```

`undefined` 同时代表：

- 目录真的不存在（可以 cleanup-only）；
- 目录存在但 **权限错误/readdir 失败**；
- 目录是 **junction/symlink**（R2a 故意返回 undefined）；
- `sessionsRoot` 暂时不可用；
- 路径被拒绝/不安全。

`service.delete` 看到 `undefined` 就 `cleanup(id)`（unarchive + workspace + cache）：
**一个真实存在、只是查询失败的会话，会被悄悄 unarchive**；用户看到归档消失、文件还在。
如果目录是“指向另一个 session 的 junction”，还会把链接 id 的归档状态清掉。

**修法**：`findDir` 改成 tri-state：

```js
{ state: 'present', dir, identity: { dev, ino, realpath } }
{ state: 'absent' }                 // 只在确认不存在时 cleanup-only
{ state: 'unsafe', reason }         // 拒绝，不动状态
{ state: 'error', error }           // 拒绝，不动状态
```

**红灯测试**：
- `findDir` 返回 `undefined` 但 `dirExists(id) === true`（模拟权限错误）→ delete 必须拒绝，archive 不变；
- junction 指向另一个 session → 拒绝，**不能 cleanup-only**；
- `sessionsRoot` 不可读 → 拒绝，不能把所有 archived 都 unarchive。

### D2（最高）recheck 之后、`removeDir` 之前，外部 unarchive/live 仍可抢跑

当前 `beforeStep('rm')` 在 **recheck 之前**：

```js
await beforeStep('rm')
if (!contains(readArchived(), id)) return ...
if (isLive(id)) return ...
removeDir(dir)
```

`beforeStep` 只能测“recheck 前”的竞态。recheck 与 `removeDir` 之间仍有窗口：
外部代码（另一个 service 实例、workspace 服务、用户 unarchive、会话被打开）可以改状态。

**修法**：
- recheck 后写 durable **claim/deleting**（CAS/revision），外部 unarchive/live 打开看到 claim 就拒绝；
- 或在 `removeDir` 之前再加 `beforeRemove` 钩子，并把测试注入到那个窗口；
- 仅靠 in-memory per-id 锁不够，因为外部写入不经过这个锁。

**红灯测试**：
- 在 `removeDir` 的注入实现里先 `archived.delete(id)`（模拟外部 unarchive）再执行 rm；
  期望 delete 拒绝，文件保留；
- 在 `removeDir` 注入里先 `live.add(id)`；期望拒绝；
- 当前 service 会直接 rm，红。

### D3（最高）`heal()` 完全绕过 per-id 锁

```js
function heal() { for (const id of pendingCleanup) cleanup(id) }
```

`cleanup` 直接 `unarchive/dropWorkspaceRows/scrubCache`，不经过 `withLock`。
`list()` 每 3 秒调 `heal()`；它可以在 delete 的 recheck 与 rm 之间把 id unarchive，或与 `unarchiveSession` 并发。

**修法**：`heal` 必须 `await withLock(id, ...)`；`list()` 要么异步 heal 后再返回，要么返回 pending 状态。
**红灯测试**：pending id + 并发 heal/delete/ unarchive，用 barrier 断言不会双重 unarchive/双重清理。

### D4（最高）`pendingCleanup` 只在内存，进程重启后幽灵永远在

`pendingCleanup` 是 `new Set()`；崩溃/重启后为空。
此时文件已删、archive 还在（R5-1），`list()` 不会 heal；用户必须再点一次 delete 才触发 cleanup-only。
workspace 幽灵同理（R5-2）。

**修法**：durable manifest/journal（trash manifest 正好可以承担），启动时加载 pending；`list()` 读它。
**红灯测试**：service A 失败 unarchive/workspace；构造 service B（同一存储），不调用 delete，只 `list()`；
断言 ghost 被清理或至少标记为 pending；当前 B 的 pending 为空，红。

### D5（高）`cleanup()` 对“已经 unarchive”不幂等，pending 永久不消失

```js
try { deps.unarchive(id) } catch { failed.push('unarchive'); pending.add(id) }
```

如果 `unarchive` 在已经 unarchive 时抛错/返回失败，`cleanup` 会把 id 永久留在 pending；
即使 workspace/cache 都成功，`heal` 每次仍把 unarchive 算失败。
**测试**：unarchive 实现为“不在 archived 就 throw”；第一次 workspace 失败 → pending；
第二次 heal：unarchive throw, workspace success, cache success → pending 仍然；`heal` 永远不返回 healed。
**修法**：`cleanup` 先检查当前 archived；unarchive 幂等；或把“已 unarchive”当成功。

### D6（高）`cleanup-only` 没有重新检查 live

`delete` 在 find 前检查 live；如果 `findDir` 返回 `absent`（文件已删），
在 cleanup 前会话变为 live（理论上 archived+live 仍可能），cleanup 会 unarchive 一个 live 会话。
**测试**：`findDir` 返回 undefined，`isLive` 第一次 false、cleanup 时 true；
期望拒绝/延迟；当前 cleanup 不看 live。

### D7（高）路径身份 TOCTOU：`findDir` 之后目录被换成另一个真实 session

`removeDir(dir)` 校验的是“路径在 root 内、不是链接”，但没校验“它还是 find 时那个目录”。
攻击者/并发操作可以把真实 session rename 走，把另一个真实 session 放到同路径；
`removeDir` 会删掉错误的 session（仍在 root 内、不是链接，所有检查都通过）。

**修法**：`findDir` 返回 `{dev, ino, realpath}`；`removeDir` 在删除前 `lstat` 比对 identity；
不匹配就拒绝。Windows `ino` 可用；或持有目录句柄/使用 rename 的原子性。
**测试**：`beforeStep('rm')` 后 rename 原 session，把 sibling 放到原路径；期望拒绝，sibling 存活。

### D8（高）两个 service 实例 / 两个进程：in-memory 锁不跨实例

`locks` 是 `createArchiveService` 内的 Map。两个 service 实例（HMR/两个 host）可以同时通过 archived 检查，
一个 rename/remove，一个 unarchive/删除；durable claim 才能互斥。
**测试**：同一 deps/世界，两个 `createArchiveService` 同时 delete；断言最多一个成功/rename 一次。
当前 per-id 锁不跨实例，红。

### D9（中）route 丢掉 service 的稳定 `reason`

`service.delete` 返回 `status`/`reason`，但 `createDeleteHandler` 一律 `ok?200:409`，body 只有 `error:'delete refused'`。
UI 无法区分 not-archived / live / dir-missing / remove-failed / cleanup-only。
**修法**：返回 `{ok, status, reason}` 的**白名单** reason，不返回路径/异常原文。
**测试**：service 返回 `{ok:false, reason:'session-is-live'}` → route body `reason` 可见，状态码 409。

### D10（中）`readArchived` 与 `isLive` 是两次独立读取

中间状态可能变；没有 revision/CAS。当前 recheck 后有窗口（D2）。
**修法**：`readState(id) -> {archived, live, revision}` 一次读；claim 时比较 revision。

---

## 第三部分：建议的最终状态机（最小版）

```
archived
  ├─ claim(deleting)  ── 失败 → 保持 archived
  ├─ rename → trash   ── 失败 → 释放 claim，保持 archived
  ├─ unarchive/workspace/cache ── 失败 → 保持 trashed + pending，heal 重试
  ├─ delete trash     ── 失败 → 保持 trashed + pending
  └─ done
```

- 所有状态写 durable journal（每次原子写）。
- `delete`/`unarchive`/`heal` 都经过同一个 `withLock` + claim。
- `list()` 读 journal，显示 `deleting/trashed/pending` 状态；不是简单 `readArchived`。
- `cleanup-only` 只在 `findDir.state === 'absent'` **且 journal 确认没有 trash 条目** 时执行。
- 任何 `findDir.state` 为 `unsafe/error` → 拒绝，不动 archive。

---

## 第四部分：优先级

1. **D1 + D2 + D3 + D4** 是数据损失/幽灵状态，必须先修；
2. **D5/D6/D7/D8** 是并发/幂等/身份，trash 前修；
3. **D9/D10** 是 UX/一致性；
4. 然后再引入 trash，按 T1–T10 验收。

一句话：**trash 不是“rename 一下”就完了；它是“durable claim + manifest + 可恢复状态机”。**
没有这层，rename 只是把“删一半”换成“移一半”。
