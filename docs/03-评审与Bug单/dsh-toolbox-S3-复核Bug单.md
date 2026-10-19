# dsh-toolbox S3 复核 · Bug 单

> 审查对象：commit `33b83fd`（含 notice UI，101 tests）
> 复核：`npm test` **101 pass**；`npm pack` + 干净 `npm ci` 后 host import 通过；`tools/prove-red.mjs` **11 红 / 22**。
> 结论：**S3 暂不盖章。** 有 2 个 P1 代码问题（其中 1 个是数据丢失），外加 3 个矩阵缺口。
> S4 可以并行启动，但 S3 不能标记完成；修完 P1 + 补测试后再盖章。

---

## P1-1 坏掉的 backup 会覆盖一个好草稿（D6 缺失，当前代码必现）

**位置**：`src/client/features/draft-guard.js` 的 `backupRead()` / `decideRead()`

`backupRead()` 只检查了：

```js
typeof parsed.raw === 'string' && typeof parsed.key === 'string'
```

但没有检查 `parsed.raw` 本身是不是一个**可解析的 draft JSON**。于是：

```js
// 预置：localStorage 里有一个正常的草稿
setItem('dsh.conversation.x', draftValue('my real draft'))

// 预置：BACKUP_KEY 是一段坏数据，但字段形状对
setItem(BACKUP_KEY, JSON.stringify({
  v:1, key:'dsh.conversation.x', raw:'not-json', chars:1, preview:'x'
}))

installDraftGuard(() => localStorage)
getItem('dsh.conversation.x')
// 实际返回：'not-json'
// 预期返回：原来的 draftValue('my real draft')
```

`decideRead()` 里：

```js
const newest = draftTextOf(backup.raw)        // ''（因为 raw 不是合法 draft）
const own = draftTextOf(raw)                  // 'my real draft'
if (newest.trim() === '') return own.trim() === '' ? raw : backup.raw
// own 非空 → 返回 backup.raw = 'not-json'
```

Harness 的 `readConversationDraft()` 会 `JSON.parse('not-json')` 失败 → 返回空草稿。
**用户打开会话，草稿“消失”了**；随后一写就可能覆盖掉原来的键。这是数据丢失，不是 UI 小问题。

**修法**：`backupRead()` 里增加：

```js
if (!String(parsed.key).startsWith(DRAFT_PREFIX)) return null
if (!readDraftValue(parsed.raw).ok) return null   // 关键
```

坏 backup 一律当作“没有 backup”，`decideRead()` 返回 `raw`（用户原有草稿）。
**不要**删除坏 backup（可能还能人工恢复）；下次合法写入会替换它。

**补测试 D6**：
- 预置正常草稿 + 坏 backup（`raw:'not-json'` / 缺 `draft` / `key` 不在 `dsh.conversation.` 前缀）→ `getItem` 必须返回原草稿，不能返回坏 raw。
- 坏 backup 不得触发 notice。
- 坏 backup 不得被 `removeItem`/`clear`。

---

## P1-2 实例 wrapper 没有 `this` 守卫：`localStorage.setItem.call(sessionStorage, ...)` 会写 backup

**位置**：`src/client/features/draft-guard.js` 的 `makeSetItem` / `makeGetItem`（instance 分支）

矩阵 C1/C2 只测了：

- `sessionStorage.setItem(...)` 直接调用（安全）
- `Storage.prototype.setItem.call(sessionStorage, ...)`（安全）

但没有测 **把 `localStorage.setItem` 这个实例 wrapper 以另一个 Storage 为 `this` 调用**：

```js
const patched = localStorage.setItem
patched.call(sessionStorage, 'dsh.conversation.x', draftValue('cross'))
// 实际：sessionStorage 写入成功，同时 localStorage.BACKUP_KEY 被写
```

我实际跑了，输出：

```
session value: true
backup: {"v":1,...,"key":"dsh.conversation.x","raw":"...cross..."}
```

原因：instance wrapper 的 `invoke` 对任意 `this` 都执行，`onWrite` 没有检查 `this === first`。
这直接违反“sessionStorage 不被污染”的安全目标；虽然 DSH 正常路径不会这么调，但矩阵要求的是绝对安全。

**修法**：在 `makeSetItem` / `makeGetItem` 的 `onWrite` / `onRead` 之前加：

```js
if (!state.active || this !== first) return result / raw
```

（prototype fallback 的 `isMine` 已经有；instance 分支漏了。）
**补测试 C4**：
- `const p = localStorage.setItem; p.call(sessionStorage, DRAFT_KEY, draftValue('cross'))`
  → `sessionStorage` 有值，`BACKUP_KEY` 仍为 null。
- `const g = localStorage.getItem; g.call(sessionStorage, DRAFT_KEY)` → 不触发 notice、不读 backup。
- `sessionStorage` 自己的 `getItem/setItem` 不被替换（已有 C1）。

---

## P2-1 矩阵的 A5 并没有真的用“第二个 module 实例”

`test/draft-storage-safety.test.mjs`：

```js
install: (options) => install(world, options),
installAgain: (options) => install(world, options),
```

两个都是同一个模块的 `installDraftGuard`，A5 只是走了同一个 `LIVE` WeakMap 的 `reused`，没有测到：
- 第二个 module instance（HMR / double eval）看不到第一个的 `LIVE`；
- 它只能靠 `PATCH_MARK` 检测并返回 `conflict`。

F1 用了一个 fake 的 marked function，能覆盖 marker 路径；但 A5 的标题“second module instance”是假的。

**修法**：用 `await import('../src/client/features/draft-guard.js?second=1')` 得到第二个 module 实例，`installAgain` 用它；断言 `conflict` 或 `reused`，最终 dispose 后回到原始。

---

## P2-2 D5（Quota）/ D6（坏 backup）不在 22 项里

`test/support/storage-matrix.mjs` 的 CASES 只有 D1–D4、D7；我上一轮 S3 清单里的 **D5（QuotaExceededError）** 和 **D6（坏 JSON/缺字段 backup）** 没写。
D6 不是“补测试就好”，当前代码会失败（见 P1-1）。

**补 D5**：
- 主写入抛 `QuotaExceededError`：原异常保留、不递归、不写 backup、dispose 正常。
- 只有 backup 写入抛 quota：主草稿写入成功，backup 失败被吞，不崩。

**补 D6**：见 P1-1。

---

## P2-3 “needs-refresh / unsupported”只有 console，没有可见提示

`draft-guard` 在第三方 patch、frozen、restore 失败时会把 `status` 置为 `needs-refresh` / `unsupported`；
`draft-saver.mount` 只在 mount 时 `console.warn`，`window.__DSH_TOOLBOX_DRAFT__` 是诊断用，不是 UI。
用户关掉开关后如果 restore 失败，页面不会告诉他“需要刷新”，只会在 console 里有一行。

上一轮 S3 清单要求“还原失败提示需刷新”。建议：
- 在设置卡片或 notice strip 里显示 `needs-refresh`/`unsupported` 状态；或
- `draft-saver.mount` 用一个可见的 toast/notice，至少不要静默。

**P2，不阻断 S4，但 S3 清单里应有。**

---

## P2-4 notice UI 的 copy 定时器没有卸载清理

`draft-notice.js`：

```js
copyText(draft).then((done) => {
  setCopied(...)
  bus.publish(...)
  setTimeout(() => setCopied(''), 1800)   // 没有存 timer、没有 clear
})
```

组件在 1.8s 内卸载（关开关/切会话）时，这个 timer 仍会跑一次 `setCopied`。
React 18 不再警告，但仍是 timer 泄漏。建议用 ref + cleanup。
另外 `draft-notice.test` 只测 bus/isMyNotice/mountNotice，没有真正渲染组件，`copy`/`clear`/auto-dismiss 的 UI 行为没有单元测试。P2/P3。

---

## P3 README 仍是 S1 / 29 项

`README.md` 还写着：

> 状态：S1（骨架 + 纠错阶段）…… 本包尚未安装到任何 profile…… 29 项，全绿

S3 已经 101 tests、已安装、已真机验证。建议 S3 收尾一起更新，否则下一位读者会被误导。

---

## 复核结论

| 项 | 结果 |
|---|---|
| `npm test` | **101 pass**（不是 93；notice UI 加了 8 项；`test/support/*.mjs` 也被 node 当测试文件计入） |
| `npm pack` + 干净 `npm ci` | 通过；host import 正常 |
| `prove-red` | 22 项里 11 红，矩阵确实咬旧实现 |
| Storage 默认实现 | 实例 patch，原型只在注释/降级分支；符合要求 |
| **P1-1 坏 backup** | ❌ 当前会返回坏 raw，可能丢草稿；必须修 |
| **P1-2 `this` 守卫** | ❌ `localStorage.setItem.call(sessionStorage,...)` 会写 backup；必须修 |
| D5/D6 | ❌ 缺测试；D6 代码也不通过 |
| A5 | ⚠️ 没有真的第二 module |
| needs-refresh UI | ⚠️ 只有 console |
| README | ⚠️ 过期 |

**建议：S3 暂不盖章。** 修 P1-1 / P1-2、补 D5 / D6 / C4、把 A5 换成真第二 module，再跑 101+ 全绿 + 真机 G1–G3；我立刻盖 S3 PASS。

**S4 可以并行启动**（面板收纳/归档不依赖 storage guard），但不要把 S3 标记为完成；P1 是数据丢失和跨存储污染，不能带到 S4 之后。
