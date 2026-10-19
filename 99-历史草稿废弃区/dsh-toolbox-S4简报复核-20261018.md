# S4 进度简报复核 + 下一轮施工单

> 审阅对象：`dsh-plugins/dsh-toolbox/docs/S4-进度简报.md`
> 复核时间：2026-10-18
> 复核时 HEAD：`c4402c3`（简报写的是 `0b8f776`，落后一个 docs 提交，不影响结论）
> 复核方式：实跑 `npm test`、源码逐段核对、对 `unarchiveSession` 做了一次真实的超时复现

---

## 一、结论

简报的总体判断——**底层已完成、界面只到“能列/能删/能恢复”、垃圾箱页签未做**——基本成立。

但简报里“**能恢复**”这一句现在不成立：

> **`service.unarchiveSession()` 在遇到 `trashed` / `cleaned` 记录时会发生同 id 死锁。**
> 当前测试 330 项全绿，是因为没有一条测试走“删除后走 unarchiveSession 恢复”的路径。

所以下一轮不能直接开垃圾箱页签；**先修恢复死锁，再谈 UI**。

---

## 二、实跑证据

### 1. 全量测试

```text
npm test
ℹ tests 330
ℹ pass 330
ℹ fail 0
ℹ skipped 0
```

简报的 330 / 330 属实。

### 2. 恢复死锁（新发现，P0）

用真实 `createArchiveService` + 测试世界：

```text
delete -> ok:true, movedToTrash:true, recoverable:true, keptDays:7
unarchiveSession -> 1 秒超时，未返回
```

代码路径：

```text
src/host/features/archive/service.js:421  unarchiveSession()
  -> withLock(id, async () => { ... })       // 第一次拿锁
  -> src/.../service.js:427  await restore(id)
  -> src/.../service.js:371  restore()
  -> withLock(id, async () => { ... })       // 同 id 第二次拿锁，永远等第一次
```

这不是“恢复慢”，是**永久挂起**。垃圾箱页签一旦接上“恢复”，用户点一次就会卡住。

### 3. 文案与真实行为相反（P1，但会直接误导用户）

`src/client/features/archive-panel.js:159` 仍然写着：

```text
确定要彻底删除这个会话吗？
删除后无法恢复。
```

而现在的服务层行为是：

```text
finish() -> phase: cleaned
removedDir: true, movedToTrash: true, recoverable: true, keptDays: 7
```

即“移入回收箱，保留 7 天”。用户看到的却是“永久删除”，这是**信任问题**，不是文案小事。

另外 `view.pending` / `panel.askRemove()` 这套内联二次确认已经写好，但实际点击走的是 `window.confirm`，`view.pending` 分支是死代码。

### 4. 拒绝原因到不了 UI（P1）

服务层返回的是稳定码（`session-is-live`、`trash-full`、`journal-corrupt` 等），但传输层把它们丢了：

- `src/host/features/archive/route-guard.js:230-232` 只回 `{ ok, removedDir }`，失败只给 `error: 'delete refused'`；
- `src/host/features/archive/api-routes.js:118` 的 unarchive 也只回 `error: 'unarchive refused'`；
- 客户端 `archive-client.js` 读的是 `body.reason`，不是 `body.error`。

结果：`archive-panel-model.js` 里精心写的 `REASON_TEXT` 基本走不到，用户只会看到“操作失败：request-failed”。

还有一层**码名不一致**：

| 服务层实际码 | `REASON_TEXT` 里的键 |
|---|---|
| `session-is-live` | `live` |
| `session-became-live` | 无 |
| `cross-volume-trash` | `cross-device` |
| `no-longer-archived` | 无 |
| `dir-absent` | 无 |

即使把 `reason` 透传，也必须先补别名/统一码表，否则仍然显示通用错误。

---

## 三、垃圾箱页签真正缺的是什么

服务层已经有 `restore()` / `purge()`，但**没有对外暴露“垃圾箱列表”**，也没有对应路由。当前 `host-feature.js` 只注册：

```text
GET  /api/archive-manager/token
GET  /api/archive-manager/list
POST /api/archive-manager/unarchive
POST /api/archive-manager/delete
```

下一轮至少需要：

| 路由 | 作用 | 要求 |
|---|---|---|
| `GET /api/archive-manager/trash` | 列出可恢复条目 | 只回 `id/phase/at/keptDays/expiresAt`，**绝不回 `trashPath` / `originalPath` / nonce** |
| `POST /api/archive-manager/restore` | 从回收箱恢复 | body `{sessionId}`，走 `service.restore()` |
| `POST /api/archive-manager/purge` | 彻底删除 | body `{sessionId}`，必须二次确认；只允许 `cleaned/trashed` |

同时：

1. `service` 增加 `listTrash()`，先 `heal()` 或明确只列 `trashed/cleaned`；`journal.health().corrupt` 时 fail closed。
2. 返回 `protectedCount` / `maxProtected` / `keptDays`，让面板能显示“回收箱已满（200）”和“剩余 N 天”。
3. `host-feature.js` 把新路由和现有四条**成对/成组注册**，任一失败整体回滚，不能留半条。
4. `api-routes.js` 复用同一个 guard（GET/POST 都允许），body 上限、JSON 校验、错误码白名单保持一致。
5. `archive-client.js` 增加 `trash()` / `restore()` / `purge()`，仍然只在闭包持 token，401 单飞刷新一次。

---

## 四、其它需要一起收口的点

### 1. 恢复路径的 journal 校验还不完整（P1）

`service.js:116-123` 的 `entryIsSane()` 只校验了：

```js
entry.trashPath.startsWith(root + '/') || entry.trashPath.startsWith(root + '\\')
```

`originalPath` 只检查“是字符串”，没有校验它是否仍在 sessions 根内；`trashPath` 的 `startsWith` 也挡不住 `root/../...` 这类词法穿越。

`restore()` 直接：

```js
deps.renamePath(entry.trashPath, entry.originalPath)
```

建议：

- `entryIsSane()` 对 `trashPath` 和 `originalPath` 都做 `realpath` / `isInside` 边界校验；
- 或在 claim 里记录 `sessionsRoot`，恢复时复核目标仍在 sessions 根内；
- 加一条“journal 被篡改成 `../outside` 时拒绝恢复”的测试。

### 2. `trash-sweep` 会清 `trashed`，可能留下归档幽灵（P1）

`trash-sweep.js:37` 同时处理 `cleaned` 和 `trashed`。`trashed` 的语义是“已移动但 bookkeeping 还没完成”，直接 `purge()` 可能留下 `archivedSessionIds` 里的幽灵标记。

建议顺序改成：

```text
service.heal()  -> 把能完成的 trashed 变成 cleaned
只 purge cleaned（或 purge 前强制作完 cleanup）
```

并补“trashed + 超过 TTL”的测试。

### 3. 样式项可能是旧结论（P2）

源码里已经有：

```css
.dsh-toolbox-archive ul { overflow-y:auto; ... }
.dsh-toolbox-archive button { ... }
```

`client.js` 也已包含这段 CSS。简报说“列表不能滚动、按钮浏览器默认样式”，可能是旧构建或浏览器缓存，不一定是当前源码。

下一轮先做一件事再决定要不要重写样式：

```text
npm run build
浏览器 Ctrl+F5
```

如果仍然难看，再补 tabs / badge / 确认条样式；不要先花半轮重做已经存在的 CSS。

### 4. `archiveHttpApi` 的生产默认值

代码默认是 `false`（正确），但当前 `~/.dsh/profiles/web/cordis.patch.yml` 里是 `true`（联调需要）。这不是 bug，但发布/交付前要明确：

- 本机继续 `true`：面板可用；
- 打包默认 `false`：安装后要用户显式打开第 7 个开关。

### 5. `pluginZh` 仍是空开关（P2，按计划最后做）

`src/client/features.js` 的 `plugin-zh` 仍只 `track` 一个空 listener；真正干活的是独立 `dsh-plugin-zh` bundle。

在垃圾箱页签闭环前不要动它，否则会同时改两个汉化实现，容易双重翻译。迁移时二选一：

- 把 `dsh-plugin-zh` 的 MutationObserver + 字典搬进 toolbox，并从 profile 移除独立 bundle；
- 或承认它是独立插件，删掉 toolbox 里的空开关，避免“拨了没反应”。

---

## 五、下一轮建议顺序

### 第 1 步：P0 恢复死锁（必须先做）

- 抽出 `restoreLocked(id)`（不拿锁），`restore(id)` 只负责 `withLock(id, () => restoreLocked(id))`；
- `unarchiveSession()` 内部改调 `restoreLocked(id)`；
- 加回归测试：`delete -> unarchiveSession` 必须在超时内返回，且目录回到原路径；
- 同时覆盖 `cleaned` / `trashed` 两种 phase。

### 第 2 步：把“删除”说成人话

- 面板文案改为“移入回收箱（保留 7 天，可恢复）”；
- 删掉“彻底删除/无法恢复”；
- 使用已有的 `pending` 内联确认，或至少让 `window.confirm` 文案与真实行为一致；
- HTTP 响应增加安全字段 `movedToTrash/recoverable/keptDays`，UI 显示保留期。

### 第 3 步：错误码白名单

- `route-guard` / `api-routes` 只透传白名单 reason（`session-is-live`、`trash-full`、`journal-corrupt` 等），绝不透传路径/异常文本；
- `REASON_TEXT` 补齐服务层实际码，或统一改成一套码；
- 加测试：删除被拒时响应含 `reason`，且不含绝对路径。

### 第 4 步：垃圾箱 API + 页签

- 按第三节的 `trash/restore/purge` 三条路由实现；
- 面板加“归档 / 回收箱”两个 tab；
- 回收箱显示剩余天数、恢复、彻底删除（二次确认）；
- `trash-full` / `journal-corrupt` 有可见提示。

### 第 5 步：样式与真机

- `npm run build` + Ctrl+F5；
- 滚动、按钮、确认条用主题 token；
- 真机验证：列归档、移入回收箱、回收箱列表、恢复、彻底删除、刷新后状态仍对。

### 第 6 步：plugin-zh 迁移

放到最后，按第 4 节第 5 条二选一，不要和垃圾箱页签混在一轮。

---

## 六、验收判据（给 Harness）

1. `npm test` 全绿，新增“删除后 unarchiveSession 恢复”的回归测试，且不会超时。
2. 删除后的 HTTP 响应能说明“已移入回收箱、保留 7 天、可恢复”，不再是“无法恢复”。
3. `live / trash-full / journal-corrupt` 等拒绝原因能在 UI 看到，不是 `request-failed`。
4. `GET /trash` 不返回任何绝对路径、nonce、`originalPath`、`trashPath`。
5. 回收箱恢复后，目录回到原路径；purge 后 journal 条目被删除。
6. 关闭 `archiveHttpApi` 后，四条（或七条）路由全部撤销，旧 token 立即 401。
7. 干净构建 + `npm pack` 可安装，`client.js` 与源码一致。

---

## 七、需要你定夺的两件事

1. **`archiveHttpApi` 交付策略**：本机继续开，还是打包默认关、由用户安装后手动开？我建议后者（代码默认已经是 `false`，当前 profile 的 `true` 只用于联调）。
2. **回收箱保留期**：固定 7 天，还是做成配置？当前代码是 7 天硬编码默认值；如果要做配置，应该在垃圾箱页签一起设计，不要先写死再返工。
