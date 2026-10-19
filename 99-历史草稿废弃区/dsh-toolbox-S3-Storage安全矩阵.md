# dsh-toolbox S3 · draft-saver Storage 安全矩阵（交付给 Harness）

> 用途：**先写测试，再动代码。** 这份清单里的用例在旧实现（patch `Storage.prototype`）上必须能红；
> 红得对，才允许改代码。全部绿 + 真机 E2E 通过，才算 S3 完成。

---

## 0. 先定死 8 条实现约束（代码 review 逐条对）

| # | 约束 | 原因 |
|---|---|---|
| 1 | **只 patch `localStorage` 实例**，不 patch `Storage.prototype` | 原型是 `sessionStorage` 和所有同源 Storage 共享的；patch 原型会误伤别人 |
| 2 | 如果必须 patch 原型（例如浏览器里 localStorage 不是稳定实例），wrapper 里必须 `if (this !== localStorage) return orig.call(this, ...)` | 防止 `sessionStorage` 被拦截 |
| 3 | 原始方法只捕获一次；备份 IO 永远走**原始方法**（`origGet.call(localStorage,...)`） | 防止 wrapper 递归 |
| 4 | wrapper 带 `active` 标志和 `Symbol.for('dsh.draft-saver.patch')` 标记 | dispose 后旧引用必须退化为透明转发；重复挂载可检测 |
| 5 | dispose 只在“当前函数仍是我”时还原；否则**不要覆盖**，标记“需刷新” | 不能把第三方后加的 patch 抹掉 |
| 6 | 单例/引用计数：第二次 mount 复用同一个 disposer，或明确拒绝；绝不能产生 wrapper 链 | 双挂/ HMR 是真实发生过的 |
| 7 | dispose 幂等、不抛错；**绝不删除 `dsh-draft-saver.backup.v1`，绝不 `clear()`** | 备份是用户数据，不是缓存 |
| 8 | 模块级 `notice` / `lastRead` / `uninstallGuard` 移入每次 mount 的实例；dispose 清 timer/listener | 关掉再开不能带旧状态 |

---

## 1. 测试矩阵

> 建议文件名：`test/draft-storage-safety.test.mjs`
> Fake Storage 必须用**类 + 原型方法**，并创建两个实例（`localStorage`、`sessionStorage`）共享同一原型；
> 只用一个对象测，测不出 `this` 和原型污染。

### A. 身份与生命周期

| ID | 用例 | 断言 |
|---|---|---|
| A1 | mount 后检查 patch 目标 | `Storage.prototype.getItem/setItem` **仍是原始函数**；`localStorage.getItem/setItem` 是包装（实例自有属性或可识别的包装） |
| A2 | dispose 后身份还原 | `localStorage.getItem === originalGet`、`setItem === originalSet`（严格 `===`，不是行为相等）；实例自有属性被删除/还原 |
| A3 | dispose 两次 | 第二次是 no-op；不抛错；不再触发任何备份写入 |
| A4 | mount → dispose → mount ×5 | 始终只有一层包装；每次 dispose 后严格等于原始函数；没有 `P2 → P1 → O` 链 |
| A5 | 双 eval / HMR 模拟 | 在两个 module 实例里各 mount 一次，按 A→B 和 B→A 两种顺序 dispose；最终必须回到原始函数；不能留下永久 wrapper |

### B. 所有权与第三方 patch

| ID | 用例 | 断言 |
|---|---|---|
| B1 | toolbox mount 后，第三方替换 `localStorage.setItem` | toolbox dispose **不得覆盖第三方**；第三方函数仍在；控制台有明确警告/“需刷新”标记 |
| B2 | 第三方先 patch，toolbox 后 mount | toolbox 捕获的是第三方函数；dispose 后回到**第三方函数**（不是原始函数）；或明确拒绝 mount。选一种并写进注释 |
| B3 | `localStorage.setItem` 改成 non-writable / `Object.freeze` | mount 不崩溃（或明确拒绝）；dispose 不崩溃；状态明确提示“需刷新”，不能假装已关闭 |
| B4 | 每次访问 `window.localStorage` 返回不同实例（模拟怪异环境） | 要么稳定 patch 到当前实例并检测替换，要么退回带 `this` 守卫的原型 patch；不能静默 patch 到错误对象 |

### C. 跨 Storage 污染

| ID | 用例 | 断言 |
|---|---|---|
| C1 | `sessionStorage.setItem('dsh.conversation.x', ...)` | 不被拦截；`dsh-draft-saver.backup.v1` 不被写；`sessionStorage.getItem` 不被替换 |
| C2 | `Storage.prototype.setItem.call(sessionStorage, ...)` | 使用实例 patch 时自然绕过；使用原型 patch 时 `this` 守卫必须放行 |
| C3 | 同源 iframe / 另一个 realm（可选） | 各自原型独立；不能假设能 patch 到别的 realm；文档写清限制 |

### D. 数据正确性（不能丢草稿）

| ID | 用例 | 断言 |
|---|---|---|
| D1 | 通过 patched `setItem` 写草稿 | 原始 `dsh.conversation.<id>` 键仍保留正确值；`BACKUP_KEY` 写入最新记录 |
| D2 | dispose 后 | `BACKUP_KEY` 仍在，内容不变；草稿键仍在；**没有** remove/clear |
| D3 | dispose 后重新 mount | 能从 `BACKUP_KEY` 恢复最新草稿；恢复后的 rehydration 写回不会被误判为“用户输入”而覆盖备份 |
| D4 | 空草稿 / 发送后 | 共享草稿跟随为空；`EMPTY_DRAFT` 语义保持；不把空白当有效内容 |
| D5 | `origSet` 抛 `QuotaExceededError` | 原异常语义保留；wrapper 不递归；备份写失败被吞掉但不影响主写入；dispose 仍可执行 |
| D6 | `BACKUP_KEY` 里是坏 JSON / 缺字段 | 不崩溃；当作没有备份；不覆盖用户草稿 |
| D7 | `lastRead` 超过 512 | Map 被清空；内存不无界增长；行为与旧实现一致 |

### E. active / 旧引用

| ID | 用例 | 断言 |
|---|---|---|
| E1 | mount 前缓存 `const old = localStorage.setItem`；dispose 后调用 `old.call(localStorage, ...)` | 旧 wrapper 的 `active=false`：透明转发，不写备份、不弹提示 |
| E2 | dispose 后 `getItem` | 不发布 notice；不触发 React 状态更新 |
| E3 | dispose 后 `setItem` | 不写 `BACKUP_KEY`；只走原始方法 |
| E4 | 卸载时还有 notice timer / copy 状态 timer | 全部 clear；无 unmounted state update |

### F. 共存与重复注册

| ID | 用例 | 断言 |
|---|---|---|
| F1 | 旧 `dsh-draft-saver` 已 patch（带 marker） | 新 toolbox 检测到 marker：拒绝第二次 patch，或复用；不能双 patch；日志可读 |
| F2 | 同一 feature 被 double mount（容器 bug/测试） | 单例守卫：只一层；dispose 一次即还原 |
| F3 | 第三方在 toolbox 之后 patch（同 B1） | 见 B1；不许覆盖 |
| F4 | HMR reload | 旧实例 dispose 后新实例 mount；无链、无旧 timer、无旧 listener |

### G. 真实浏览器 E2E（Node fake 测不出浏览器 Storage 行为）

| ID | 用例 | 断言 |
|---|---|---|
| G1 | Chrome/Edge 打开 DSH | 控制台断言：mount 前 `localStorage.setItem` 是原始；mount 后是 wrapper；off 后严格回到原始；`Storage.prototype.setItem` 始终原始 |
| G2 | 真机开关 | 打开草稿保险箱 → 写一句草稿 → 关掉 → 刷新；草稿仍在、备份仍在；再打开能恢复 |
| G3 | 真机跨 storage | `sessionStorage` 写同名 key，`BACKUP_KEY` 不被写；侧栏/其他 localStorage 功能不受影响 |
| G4 | 双 tab（可选但推荐） | 两个 tab 都开：最后写入的草稿胜出；不出现备份被旧 tab 覆盖；不出现跨 storage |

---

## 2. “先写测试”的红灯标准

在旧实现上，下面这些必须**先红**（如果它们现在是绿的，说明测试是假的）：

1. **A1**：旧实现 patch 原型 → `Storage.prototype.setItem` 变了 → 红。
2. **A2**：旧实现还原到原型 → 可能“看起来”对；但如果用实例断言/`hasOwnProperty`，红或需要改实现。
3. **B1**：旧实现无条件 `proto.setItem = origSet` → 覆盖第三方 → 红。
4. **C1**：旧实现 patch 原型 → `sessionStorage` 被拦截 → 红。
5. **A5/F4**：双挂/双 eval → wrapper 链 → 红。
6. **E1/E2/E3**：旧实现没有 `active` 标志 → 旧引用仍写备份/弹提示 → 红。
7. **D2**：旧实现不删备份，可能绿；保留，作为回归。
8. **B3**：旧实现 freeze 下可能静默失败 → 红或需要新增“需刷新”状态。

> 红灯测试提交后，再改代码；每修一条，红灯变绿。不要先改代码再补测试。

---

## 3. S3 验收门槛

- [ ] 上面 A–F 全部绿（Node 测试）。
- [ ] G1–G3 在真实 Chrome/Edge 上手动/Playwright 通过。
- [ ] `npm test` 全绿；`npm pack` 后在临时目录安装，`import('dsh-toolbox')` 正常。
- [ ] `grep -n "Storage.prototype" src` 只在注释/降级分支出现；默认实现是实例 patch。
- [ ] dispose 后 `localStorage.setItem === original`（真机控制台）。
- [ ] 关掉草稿保险箱后，再刷新，草稿和 `dsh-draft-saver.backup.v1` 都还在。
- [ ] 旧 `dsh-draft-saver` bundle 卸载/禁用；启动自检发现 marker 时拒绝双 patch。

---

## 4. 一句话给 Harness

**先把这个文件里的 A–F 写成测试，跑一遍确认它们红；再动 draft-saver 的代码。**
S3 不看你“关掉后看起来没事”，只看：**身份还原、第三方不被覆盖、sessionStorage 不被污染、备份不丢、旧引用不写、双挂不链。**
