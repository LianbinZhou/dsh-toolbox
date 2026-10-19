# S4 复审与封板施工单

> 审阅对象：`dsh-plugins/dsh-toolbox`
> 复核提交：`3527147`（回收箱后端）
> 复核时间：2026-10-18
> 复核方式：逐提交读 diff、实跑全量测试、对关键路径做独立复现
> 审阅角色：审核官（只读复核，不改代码）

---

## 0. 结论

**340 / 340 全绿属实，但不能据此封板。**

| 项 | 结论 |
|---|---|
| P0 死锁 | **PASS**，已修好，回归测试有效 |
| 删除文案 | **PASS**，“彻底删除/无法恢复”已清除 |
| reason 透传 | **FAIL**，白名单与服务层实际码对不上，真实 `live` 仍是 `request-failed` |
| 路径校验 | **PARTIAL**，挡住了 `..`，没挡住“根外绝对路径”和 `trashPath` 的 `root/../outside` |
| sweep 顺序 | **PARTIAL**，仍会把 `trashed` 当垃圾清掉，cleanup 失败会留下归档幽灵 |
| 死锁修复后的恢复 | **有新回归**：cleanup 失败时恢复成功但归档标记仍在 |
| 回收箱后端 | **基本可用，但有缺口**：reason 未走白名单、journal corrupt 未 fail closed、缺 `maxProtected` |
| 回收箱 UI | 尚未做；按本文第 3 节定案执行 |

**在下面第 4 节的五条补完、真机链路跑通、README 更新之前，不签 S4 封板。**

---

## 1. 已拍板的产品决定

1. `archiveHttpApi` **交付默认 `false`**；本机 profile 当前保持 `true` 用于联调。
2. 回收箱保留期 **固定 7 天**，不做配置项。
3. 回收箱 UI **不新增侧栏主入口、不占主任务位置**；在现有「历史归档」面板内增加二级「回收箱」页签/按钮。功能必须与既定计划一致，用户可恢复、可彻底删除。
4. 开源说明文件必须专门写清回收箱的存在、7 天保留、恢复/彻底删除、API 路由、`archiveHttpApi` 默认关闭及安全边界。

---

## 2. 逐刀复核

### 2.1 第一刀：P0 死锁 —— PASS

修复方式正确：

- `restoreLocked(id)` 不拿锁；
- `restore(id)` 只负责 `withLock(id, () => restoreLocked(id))`；
- `unarchiveSession()` 在已持锁的上下文中调用 `restoreLocked()`，不再重入。

回归测试覆盖了：

- `cleaned` 态恢复；
- `trashed` 态恢复；
- 恢复后锁释放。

这部分可以过。

### 2.2 第二刀：删除文案 —— PASS

已确认：

- `src/client/features/archive-panel.js` 不再出现“彻底删除/无法恢复”；
- 删除按钮只进入待确认状态；
- 确认条显示“移入回收箱（保留 7 天，可恢复）”；
- 旧的 `window.confirm` 已删除；
- HTTP 响应带回 `movedToTrash / recoverable / keptDays`。

这部分可以过。

### 2.3 第三刀：reason 透传 —— FAIL（表面绿）

服务层实际码与 `PUBLIC_REASONS` 不一致：

| 服务层实际码 | `PUBLIC_REASONS` 里的值 | 实际结果 |
|---|---|---|
| `session-is-live` | `live` | `request-failed` |
| `cross-volume-trash` | `cross-device` | `request-failed` |
| `move-failed` | `remove-failed` | `request-failed` |
| `delete-in-progress` | `in-progress` | `request-failed` |
| `unsafe-path` | `unsafe-trash-root` | `request-failed` |
| `session-became-live` | 无 | `request-failed` |
| `no-longer-archived` | 无 | `request-failed` |
| `identity-changed` | 无 | `request-failed` |

实跑结果：

```text
publicReason('session-is-live')      -> 'request-failed'
REASON_TEXT['session-is-live']       -> undefined
publicReason('cross-volume-trash')   -> 'request-failed'
```

新测试 `test/archive-reason-passthrough.test.mjs` 用的是假的 `'live'`，不是服务层真实返回的 `'session-is-live'`。所以测试绿了，真实 UI 仍然拿不到具体原因。

**这是“测的不是生效的那条路”。**

### 2.4 第四刀：路径校验 —— PARTIAL

`entryIsSane()` 现在只检查：

- `originalPath` 不含 `..`；
- `originalPath` 末段等于会话 id；
- `trashPath` 以垃圾箱根开头。

它没有检查“目标是否仍在 sessions 根内”，也没有检查 `trashPath` 自身是否含 `..`。

以下路径会通过校验：

```text
C:/outside/session-aaaaaaaa-1111-2222-3333-444444444444
C:/home/storages/archive-trash/../outside/n1
```

独立复现结果：

- `originalPath = C:/outside/<ID>` 时，`restore` 已调用 `deps.renamePath`，`to` 就是根外路径；
- `trashPath = <trash>/../outside/n1` 时，`restore` 也调用了 `deps.renamePath`。

fake world 里因为源文件不存在返回 `restore-failed`，但**真实文件系统里如果源存在、目标父目录存在，就会真的移动**。

现有 `tamper` 测试只覆盖：

- `originalPath` 含 `..`；
- 末段不是 id；
- `trashPath` 完全在另一个目录。

没有覆盖“根外绝对路径”和“根内 `..` 穿越”。

### 2.5 sweep 顺序 —— PARTIAL

`trash-sweep.js` 加了 `service.heal()`，但后面仍保留：

```js
if (!entry || (entry.phase !== 'cleaned' && entry.phase !== 'trashed')) continue
```

`trashed` 是“已移动、cleanup 未完成”的待办状态，不是可清理垃圾。  
我构造了一个 `trashed`、cleanup 失败、`at` 超过 7 天的记录，实跑：

```text
{ scanned: 1, purged: 1, failed: 0 }
phase: []
trash: 0
archived: true
```

文件被物理清掉，归档标记还在，变成幽灵。  
提交说明里“不会把 trashed 当垃圾”没有在代码里兑现。

### 2.6 死锁修复带出的新回归

`unarchiveSession()` 在 `restoreLocked()` 成功后直接返回：

```js
return { ok: true, restored: true }
```

如果删除时 cleanup 失败，状态会是 `trashed`，归档标记仍在；恢复后没有补清标记。实跑：

```text
delete -> phase trashed, archived true
unarchiveSession -> ok:true, restored:true
after -> archived true, journal []
```

文件回到了原位，但会话仍在归档集合里，下一次可能又被当成归档会话处理。  
现有 `trashed` 测试是删除成功后再手工改 phase，没有覆盖“cleanup 失败”的真实中间态。

### 2.7 回收箱后端的两个小口子

1. `trashCommon` 对 `value.reason` 是原样透传，没有走 `publicReason`；理论上可以把服务层路径/异常原文带出去。
2. `listTrash()` 不检查 `journal.health().corrupt`；journal 损坏时 `read()` 返回空数组，面板会显示“回收箱为空”，而不是 fail closed。
3. `listTrash()` 没有返回 `maxProtected`，面板无法显示“回收箱已满（200）”。

---

## 3. 回收箱 UI 定案

按老板决定：**不新增侧栏入口，不占主任务位置。**

实现方式：

- 在现有「历史归档」主面板内增加二级页签/切换按钮：
  - `归档`（默认）
  - `回收箱`
- 不注册新的 `sidebar.panellist`，不注册新的 `main` 面板，不改 `panel-menu` 的收纳逻辑。
- 回收箱页签只在现有 `archive-panel` 组件内部切换视图。

回收箱页签至少显示：

- 条目数量；
- `protectedCount` / `maxProtected`（例如“回收箱 3 / 200”）；
- 每条：标题或 id 尾段、`phase`、删除时间、剩余保留天数；
- 操作：`恢复`、`彻底删除`；
- `彻底删除` 必须二次确认，文案明确“物理删除，无法恢复”；
- `trash-full`、`journal-corrupt`、`restore-failed` 要有可见提示。

验收要求：

1. 面板内可以完成“归档 → 移入回收箱 → 回收箱列表 → 恢复 → 彻底删除”全链路；
2. 关闭 `archiveHttpApi` 后，回收箱页签显示未启用，不发请求；
3. 刷新页面后，回收箱列表与恢复状态仍正确；
4. 不新增侧栏入口；
5. 不泄露 `trashPath / originalPath / nonce`。

---

## 4. 封板前必须补的五条

### 4.1 reason 码单一来源

要求：

- 以服务层 `REASONS` 为准，建立一张唯一的“内部码 → 出网码 → 中文文案”表；
- `PUBLIC_REASONS`、`publicReason()`、`REASON_TEXT` 全部从这张表生成或与之对齐；
- 不再出现 `session-is-live` 与 `live` 两套码；
- 测试必须遍历服务层真实 `REASONS` 值，而不是手写假码；
- 至少加一条集成测试：真实 service 返回 `session-is-live`，HTTP 响应里 `reason` 为 `live`，UI 能显示“正在使用中”。

建议映射：

| 服务层 | 出网 | UI |
|---|---|---|
| `session-is-live` | `live` | 这个会话正在使用中，不能删除 |
| `session-became-live` | `live` | 会话刚被打开，已取消删除 |
| `cross-volume-trash` | `cross-device` | 回收站和会话不在同一个磁盘 |
| `move-failed` | `remove-failed` | 移入回收箱失败 |
| `delete-in-progress` | `in-progress` | 这个会话正在删除中 |
| `unsafe-path` | `unsafe-path` | 路径不安全，已拒绝 |
| `no-longer-archived` | `not-archived` | 已经不在归档列表 |
| `identity-changed` | `identity-changed` | 会话目录已变化，已拒绝 |
| 其余已有码 | 保持 | 保持 |

### 4.2 双路径边界校验

要求：

- `originalPath` 必须仍在 sessions 根内；
- `trashPath` 必须仍在 trash 根内；
- 不能只用 `startsWith`，必须做 `realpath` / `isInside` 边界校验；
- 拒绝符号链接/junction 穿越；
- 拒绝 `..`；
- 补测试：
  - `originalPath = C:/outside/<ID>` 必须拒绝；
  - `trashPath = <trash>/../outside/n1` 必须拒绝；
  - 合法路径必须继续通过。

实现上可以给 `service` 注入 `sessionsRoot` 或 `isInsideSessions(path)`，不要靠末段 id 代替根校验。

### 4.3 sweep 只清 `cleaned`

要求：

- `heal()` 之后，只处理 `phase === 'cleaned'`；
- `trashed` 仍存在时，不物理清空；
- `heal()` 抛错时，也不能把 `trashed` 当垃圾；
- 补测试：`trashed + 超过 TTL + cleanup 失败` 必须 `purged: 0`，归档标记和文件都不能消失。

### 4.4 恢复后必须补清归档标记

要求：

- `restoreLocked()` 把文件放回后，`unarchiveSession()` 必须确认归档标记已清；
- 如果 cleanup 失败，不能静默返回 `ok:true`；
- 要么返回 `warning: 'cleanup-pending'`，要么保留可重试状态；
- 补测试：`failAt unarchive` → delete 得到 `trashed` 且 `archived:true` → `unarchiveSession` 后 `archived:false`。

### 4.5 回收箱接口收口

要求：

- `trashCommon` 的 `reason` 也走 `publicReason`，不再原样透传；
- `listTrash()` 检查 `journal.health().corrupt`，损坏时返回 `journal-corrupt`，不显示空列表；
- `listTrash()` 返回 `maxProtected`（至少返回 `protectedCount` 与上限）；
- `restore` / `purge` 明确只接受 POST；
- 补测试：
  - service 返回带路径的 reason 时，响应里不出现路径；
  - journal corrupt 时 `GET /trash` 返回稳定错误；
  - 响应里没有 `trashPath / originalPath / nonce`。

---

## 5. 验收矩阵

### 5.1 自动测试

```sh
npm test
# 期望：340+ tests，0 fail，0 skipped
```

新增测试必须覆盖：

- 真实 `REASONS` 码到 UI 的映射；
- `originalPath` 根外绝对路径；
- `trashPath` 的 `root/../outside`；
- `trashed` 超过 TTL 但 cleanup 失败时不清空；
- cleanup 失败后恢复，归档标记被清；
- `GET /trash` 在 journal corrupt 时 fail closed；
- 关闭 `archiveHttpApi` 后 7 条路由全部撤销、旧 token 401。

### 5.2 构建

```sh
npm run build
git diff --exit-code client.js   # 或 build-fresh 测试通过
```

### 5.3 真机链路

在 DSH 0.2.1-rc.2、`archiveHttpApi: true` 下：

1. 打开历史归档；
2. 选一个归档会话，点删除 → 确认“移入回收箱（保留 7 天，可恢复）”；
3. 切到“回收箱”，能看到条目、剩余天数；
4. 点恢复，会话回到归档/工作区；
5. 再删除一次，切到回收箱，点“彻底删除”，二次确认后条目消失；
6. 刷新页面，状态仍正确；
7. 关闭 `archiveHttpApi`，刷新，回收箱显示未启用，路由不可用。

### 5.4 文档

- `README.md` 必须从 S3 / 6 开关 / 207 测试更新到当前状态；
- 写清回收箱、7 天固定保留、恢复/彻底删除、API 路由、`archiveHttpApi` 默认 `false`；
- 写清安全边界：本地 HTTP、进程内 token、Host 白名单、同源、无 CORS、响应不含路径；
- 如果 UI 入口按本文第 3 节实现，要写“回收箱在历史归档面板内的二级页签”。

---

## 6. 给 Harness 的执行顺序

1. 先做 4.1（reason 单一来源）；
2. 再做 4.2（双路径边界）；
3. 再做 4.4（恢复后补清归档标记）；
4. 再做 4.3（sweep 只清 `cleaned`）；
5. 再做 4.5（回收箱接口收口）；
6. 最后做第 3 节回收箱页签；
7. 跑全量测试、构建、真机链路；
8. 更新 README 和 S4 简报；
9. 交付时附：commit、diff、测试原始输出、红灯/绿灯证据、真机截图或日志。

**不要只交“340 全绿”。**  
这次的问题恰恰是测试绿了，但测试没有走真实的服务码、没有覆盖根外路径、没有覆盖 cleanup 失败。封板看的是这些真实路径，不是数字。

---

## 7. 一句话

> 第 1、2 刀已经过关；第 3、4 刀只修到了测试覆盖到的那一层。  
> 把真实 reason 码、根外路径、cleanup 失败、`trashed` sweep 和回收箱 UI 这五个口子补上，S4 才能封板。
