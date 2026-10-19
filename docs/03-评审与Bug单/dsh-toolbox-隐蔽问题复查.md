# dsh-toolbox · 隐蔽问题复查（真机通电前）

> 对象：当前工作副本（commit `b09c190` + 未提交的 audit 加固 WIP）
> 结论：**audit 已从“无界写”改进为“有界+聚合”，但仍有 7 个更隐蔽的磁盘/状态雷。**
> 另外：我当前工作副本的 `npm test` 不是 240 全绿，而是 **1 个 audit 红灯**（`C · the writer truncates every string field`），说明 audit 补丁还没收口。

---

## 0. 先摆当前事实

```text
npm test
✖ C · the writer truncates every string field it accepts
  AssertionError: actor is too long
```

原因：`createAuditWriter.allow(entry)` 直接 `sink(entry)`，没有先 `pick()/truncate()`；
只有 `createFileAudit` / `createMemoryAudit` 这两个 sink 自己 pick。测试用 plain sink 就漏了。

**先修这个，再谈 240 全绿。**

---

## 1. Journal：`done` 记录只增不减，磁盘/内存二次爆破

`service.finish()`：

```js
deps.journal.write(
  deps.journal.read().map(current =>
    current.id === id ? { ...current, phase: 'done', at: Date.now() } : current
  )
)
```

`done` 记录**永远不删除**：

- `heal()` 看到 `done` 直接 `continue`；
- `list()` 过滤 `done`，但文件里还在；
- `trash-gc` 只 purge `done` 的 trash 文件，**不删 journal entry**。

后果：

- 每删一个会话，`archive-journal.json` 多一条；
- `createFileJournal.read()` 每次全量 `readFileSync + JSON.parse`；
- `write()` 每次全量写整个数组；
- 1000 次删除后，每次 delete 都要读写 1000 条；磁盘和内存都涨。

**修法**：
- `done` 记录在 trash purge 成功后**从 journal 删除**；
- 或保留有界 tombstone（最近 N 条/TTL），供“已删除”幂等查询；
- `trash-gc` 在 purge `done` 时同步清 journal；测试 1000 次删除后 journal 大小有界。

**测试**：连续删除 500 个会话；断言 journal entries 不随删除数增长（或只保留 N 条）；`read` 时间/大小有界。

---

## 2. Trash GC 的 `protected` 不受容量约束：失败删除可以填满硬盘

`trash-gc.js` 的容量循环只淘汰 `unprotected`：

```js
const unprotected = kept.filter(e => e.protectedBy === undefined)
for (...) { if (remaining <= maxEntries) break; remove... }
```

`trashed` / `cleaned` 条目**永远保留**（正确，是唯一副本）。  
但如果用户/故障连续产生 200+ 个 `trashed` 条目（unarchive/workspace 一直失败），
`maxEntries` 不会阻止，磁盘最终被回收站填满；GC 返回 `kept > maxEntries`，但没有告警。

**修法**：
- `maxProtected` / `maxTrashBytes` 硬上限；
- 超过时**拒绝新的 delete**（409 `trash-full`），并在 UI 显示“请先恢复/手动清理”；
- 不自动删 protected；
- `trash-gc` 返回 `overCapacity`，`list`/panel 显示。

**测试**：300 个 protected 条目、`maxEntries=200`；断言不静默超过，且 delete 返回明确拒绝；恢复/清理后恢复。

---

## 3. Journal 损坏被当成“空”：GC 会把 protected trash 当孤儿删掉

`journal.js`：

```js
catch (error) {
  // A missing or corrupt journal is treated as empty
  return []
}
```

`trash-gc` 读到空 → 所有 trash 条目都 `protectedBy === undefined` → 超过 TTL 就被当孤儿 purge。  
**如果 journal 损坏/丢失，回收站里唯一的用户文件会被 GC 删除。**

**修法**：
- `read()` 返回 `{ok:false, error}` / `corrupt`，不要返回 `[]`；
- 缺失（ENOENT）可按空处理；**解析失败必须 fail closed**，禁止 GC purge；
- GC/ service 看到 `corrupt` → 拒绝删除/停止 GC，显示“回收站状态损坏，请人工检查”。

**测试**：写坏 `archive-journal.json`，放一个旧的 `trashed` 目录；`gc.run()` 必须**不删**它，并返回错误。

---

## 4. `removeTrashTree` 顶层 junction 会删掉目标（T10 只测了嵌套）

我实跑：

```text
trash/link -> trash/target (junction)
removeTrashTree(trash/link, trash)
=> target/marker 被删了
```

`removeTrashTree` 第一行 `realpathSync(dir)` 把顶层 link 解析成 target；再 `walk(real)` 删 target。
T10 只测了“嵌套 junction 不被跟随”，**顶层 link 仍会跟随**。

**修法**：
```js
if (lstatSync(dir).isSymbolicLink()) throw new Error('refusing to remove a link')
```
再 `realpath`/containment；`trash-gc` 的 `remove` 也必须走这个入口。

**测试**：顶层 junction → 拒绝，target 存活；嵌套 junction 已有；real Windows junction。

---

## 5. `heal()` 的 `deleting + moved` 分支没有加锁（D3 名不副实）

```js
if (entry.phase === 'deleting') {
  const moved = deps.exists(entry.trashPath)
  if (moved) {
    deps.journal.write(... phase:'trashed' ...)   // 没锁
    const result = await finish(entry.id)          // 没锁
    ...
  }
}
```

`finish` 会做 cleanup/removeTree/journal；并发 delete/restore 可以同时进入。  
这违反 D3“heal 与 delete 同锁”。

**修法**：整个 moved 分支放进 `withLock(entry.id, ...)`，在锁内重读 journal entry；  
journal 写入仍需全局 journal 锁。

**测试**：pending `deleting` + 并发 `heal()` 与 `restore/delete`，barrier；断言只执行一次。

---

## 6. `finish()` 对“trash 已不存在”不幂等 → cleaned 卡死

流程：

```
cleanup 成功 → journal phase cleaned → removeTree(trashPath)
```

如果 `removeTree` 已经成功、但最后的 `journal.write(done)` 失败（磁盘/权限），  
journal 停在 `cleaned`；下一次 `heal/finish` 再 `removeTree` 一个不存在的路径 → 抛错 → 返回 `trash-pending`，  
**永远停在 cleaned，pending 永远清不掉**。

**修法**：
- `removeTree` 遇到 `ENOENT` 视为成功；
- `done` 写入失败可重试；或把 `cleaned` 视为“可 purge/可删除”的幂等状态；
- 测试：删除成功后让 `journal.write(done)` 抛错；重启 heal 必须能清掉，不产生永久 pending。

---

## 7. `nonce` / journal 路径未校验：路径穿越与“删错目录”

`service.js`：

```js
trashPath: trashRoot + '/' + nonce
```

`nonce` 由 `deps.nonce()` 提供；如果实现返回 `../../sessions/...` 或带分隔符，  
`renamePath`/`removeTree` 就跑到 trash 外。生产 nonce 是随机的，但这是最后一道防线。

journal 里的 `trashPath` / `originalPath` 也从磁盘读取，损坏/篡改时可指向任意路径；  
`restore` 直接 `renamePath(entry.trashPath, entry.originalPath)`，`finish` 直接 `removeTree(entry.trashPath)`。

**修法**：
- nonce 只允许 `[A-Za-z0-9_-]{16,64}`，用 `join`，并 `realpath` 校验在 trashRoot 内；
- journal 读取时校验 `id/phase/trashPath/originalPath`：id allowlist、trash 在 trashRoot、original 在 sessionsRoot；
- 不合法 entry → fail closed，不执行 rename/remove。

**测试**：nonce `../outside`；journal entry `trashPath` 指向外部；必须拒绝且外部文件存活。

---

## 8. Journal 跨实例 / 固定 temp 文件的丢失更新

`createFileJournal` 使用固定 `archive-journal.json.tmp`，无锁：

- 两个 service 实例（HMR/两个 host）同时 `write`，共用 temp，互相覆盖；
- 一个 rename 后另一个 rename 旧内容，claim 丢失。

D8 声称“claim 跨实例互斥”，但 journal 写入本身没有跨实例锁。

**修法**：
- journal 写入用**文件锁 / 唯一 temp**（`${file}.${pid}.${nonce}.tmp`）+ rename；
- 或所有 journal 变更通过一个全局 mutex/单写者；
- 测试两个 service 实例并发 delete 不同 id，journal 不丢 entry。

---

## 9. 双拼写只清一个 marker → `list()` 幽灵行

`cleanup` 用 `readArchived().includes(id)` + `unarchive(id)` 精确 id。  
archive 同时有 `uuid` 和 `session-uuid` 时，删 bare 只清 bare，`session-` 仍在；  
`list()` 仍显示它（journal 是 bare 的 done，`findEntry` 对 `session-` 找不到 → phase archived）。  
R4-9 测试靠“再删一次”收尾，但正常 UI 不一定会再删。

**修法**：cleanup 同时清除两种 canonical 拼写；`list` 对同一 canonical id 去重。  
**测试**：archive 同时两种拼写，删一次后 `list` 无幽灵、两个 marker 都清。

---

## 10. Audit 补丁本身还差几刀

除了开头的红测：

- `createFileAudit` 的 rotation 若 `renameSync` 失败（文件被占用/权限），会继续 append 到原文件，**无界增长**；必须 fallback 到 truncate 或有界 ring，不能静默。
- `createFileAudit` 没有 `0600`/目录 `0700`；审计能被同机其他用户读。
- `createFileAudit` 每行 `appendFileSync` 同步；虽然 reject 聚合了，成功操作仍同步写；建议批量/异步队列。
- `readAudit` 整文件 `readFileSync`；旋转后约 2×max，但 rotation 失败时会无界；改流式/尾部读取。
- `createAuditWriter` 没有定时 flush：最后一个窗口的拒绝若没有后续调用，永远不会落盘；加 host 生命周期 flush 或定时器。
- `createAuditWriter` 的 `counts` 按 reason 建 key；若调用方传任意 reason，Map 可无界；RPC 只传稳定码，但 writer 是公共函数，建议 cap reason 类别。

## 11. RPC 还有两个 DoS/越权点

- **`list` / `heal` 没有 rate limit**：`withinLimit` 只在有 id 时调用；已认证 UI 可以无限刷 list/heal，`allow` 审计逐条写，CPU/磁盘。
- **`hits` 淘汰会淘汰 actor key**：`while (hits.size > maxTrackedIds) delete oldest`；攻击者用 1025 个不同 id 可把 `actor:` key 挤掉，per-actor 限额被重置。actor 和 id 应分两个有界结构，或 actor key 不参与淘汰。
- **`createArchiveGateway` 仍信任 `request.principal`**：测试桩可以，真实 gateway 必须从连接身份注入，不能由请求参数传；否则 `{role:'ui',local:true}` 直接过。
- **`pickResponse` 的 `rows` 无上限**：`list` 返回全部 archived id；大量会话时响应/内存大，且 list 没有 rate。

---

## 12. 优先级

| 级别 | 项 |
|---|---|
| P0 | 1 journal done 无界、2 protected 无容量、3 journal 损坏当空、4 顶层 junction、5 heal 无锁 |
| P1 | 6 finish 不幂等、7 nonce/journal 路径、8 journal 跨实例、9 双拼写幽灵、10 audit rotation/权限、11 RPC list/heal/hits/gateway |
| P2 | 审计 flush、read 流式、removeTrashTree 深度/逐条错误、GC path 归属 |

**一句话：audit 的“无界写”修了一半；真正更容易把硬盘塞满的，是不断增长的 `archive-journal.json` 和永不淘汰的 protected trash。**
