# dsh-toolbox S3 最终复核

> 对象：commit `a93c88d`（106 tests）
> 结论：**S3 PASS。** P1-1 / P1-2 已修并有红灯转绿证据；矩阵补齐；S4 可以放行。
> 附带 1 个已知 P2（needs-refresh 无可见 UI）带入 S4，不阻断。

---

## 一、我实际跑了什么

- `npm test` → **106 pass / 0 fail**，`git status` 干净，`build-fresh` 通过。
- `node tools/prove-red.mjs` → **27 项矩阵 / 14 红**，旧实现确实被咬；工具退出码正常。
- `npm pack --dry-run` → `src/client/features/draft-guard.js`、`src/host/index.js` 都在包里。
- 干净临时目录 `npm ci` → `import('./index.js')` 正常。
- 手工复核：坏 backup 不再顶替好草稿；`localStorage.setItem.call(sessionStorage,...)` 不再写 backup。

---

## 二、两条 P1 的修复确认

### P1-1 坏 backup

`backupRead()` 现在有双重校验：

```js
if (!String(parsed.key).startsWith(DRAFT_PREFIX)) return null
if (!readDraftValue(parsed.raw).ok) return null
```

- 坏记录当“没有 backup”，`decideRead()` 返回用户原有 `raw`；
- 坏记录**原样保留**，不删除；下次合法写入替换；
- `D6` / `D6b` 覆盖：不可解析、缺 raw、缺 key、raw 形状错、key 非 draft 前缀。

### P1-2 `this` 守卫

instance wrapper 现在：

```js
if (!state.active || this !== first) return result   // set
if (!state.active || this !== first) return raw     // get
```

- `C4` 覆盖 detached wrapper 以 `sessionStorage` 为 `this`：值写到接收者，但 `BACKUP_KEY` 不写；
- 原有 C1/C2 仍绿；原型分支的 `isMine` 未变。

---

## 三、矩阵与测试

- 27 项：A1–A5、B1–B4、C1–C4、D1–D5/D5b/D6/D6b/D7、E1–E3、F1–F2。
- `A5` 现在用 `await import('...draft-guard.js?instance=2')`，是真正的第二 module；靠 `PATCH_MARK` 判 `conflict`。
- `D5` 主写入 quota、`D5b` 仅备份 quota，都有。
- `D6` / `D6b` 坏 backup 全覆盖。
- `prove-red` 在旧实现上 14 红，说明矩阵不是“全绿空转”。
- `draft-notice.js` 的 copy 1.8s timer 已用 `useRef` + cleanup 收掉。

---

## 四、仍带的 P2 / P3（不阻断 S4）

1. **`needs-refresh` / `unsupported` 仍只有 `console.warn` + `window.__DSH_TOOLBOX_DRAFT__`**，没有可见 UI。
   README 已把它列为已知边界。建议 S4 收尾时在设置卡片或 notice strip 显示一行状态；它不影响正常路径的数据安全。
2. `draft-notice` 组件仍没有真正 render 的单元测试（bus/isMyNotice/mountNotice 有测试；copy/clear/auto-dismiss 靠真机）。
3. S2 遗留的 `sinkHandlers` 模块级 Set（quote-reply）仍在；S4/S5 可顺手移入实例。
4. `client/index.js` 的 cleanup 没有 `return container.dispose()`，HMR 时异步 teardown 不被 fiber 等待；P2。
5. 旧 `dsh-draft-saver` 若仍以**未标记的原型 patch**存在，当前守卫只会实例 patch 叠加，不会识别它。
   迁移前置已要求卸载旧 bundle；S4 前请确认 profile 里没有旧 draft-saver。

---

## 五、S4 放行条件（面板收纳 / 历史归档）

S4 可以开始。动手前先做两件事：

1. **卸载旧 `dsh-panel-menu` / `dsh-archive-manager`**（据我看到的 profile 快照，它们还在 `dsh.profile.bundles` 里）；
   否则双面板入口 / 双归档入口会和 toolbox 冲突。
2. 保留 S2 的启动自检：同名工具、旧 slot id、已 patch Storage。S4 的 archive 还要重点清理：
   - `injectStyles` 的 `<style>` 要在 dispose 移除；
   - `waitObserver` / `rootObserver` 要 disconnect；
   - `renderPlain` 的 `controller.subscribe` 要 unsubscribe；
   - `setInterval` 与在途 fetch 要能停；
   - `window.__dshReactCreateRoot` 的 root 要 unmount，不能只 remove 容器。
   `panel-menu` 的 `PROXY_ENTRIES` 依赖 `[class~="dsham-entry"]`；archive 迁移时不要改掉这个 class，或同步更新 panel-menu。

---

## 六、结论

| 项 | 结论 |
|---|---|
| **S3** | **PASS**：P1-1 / P1-2 修复，27 项矩阵 + 106 tests + 14 红反向证据 |
| **S4** | **放行**：先卸载旧 panel-menu/archive，按上面的清理项验收 |
| 遗留 | needs-refresh UI（P2）、draft-notice render 测试（P3）、sinkHandlers（P2）——带入 S4/S5 |
