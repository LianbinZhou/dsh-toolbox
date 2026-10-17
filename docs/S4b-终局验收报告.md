# S4-b · 终局验收报告

> 日期：2026-10-17
> 范围：P0 隐蔽缺陷收口 + `npm pack` 修复 + 干净环境终验 + P1/P2 扫尾
> 结论：**264 项全绿、0 跳过**；`npm pack` 通过并在临时目录安装成功；**RPC 仍未绑进 `ctx.remote`（S4-c）**

---

## 一、`npm pack` 报错的真因与修法

**现象**：`npm pack` 退出码 1，报 `command failed: node tools/build.mjs && node --test`。

**真因**：不是 `files` 字段、不是 `.npmignore`、不是软链或依赖树 —— 是 **`prepack` 脚本里跑了全量测试**，而其中一条网络用例在当前机器上偶发 `fetch failed`：

```
✖ R0-a · a cross-origin POST with a VALID token is still refused
  AssertionError: fetch failed
```

**修法（两处）**：

1. `prepack` 改为 **只构建**：`node tools/build.mjs`。跑全量测试是 CI/验证的职责，把它塞进 `prepack` 会让"打包"依赖整条测试链的稳定性。
2. 顺手修掉那条 flaky：`test/support/route-attack.mjs` 的 `fire()` 对**连接失败**重试两次（50 ms 间隔）。注意重试只针对**抛错**，4xx 是响应、不重试——否则会掩盖真实的拒绝。

**结果**：

```
npm pack --dry-run  → 34 files / unpacked 279.4 kB / 退出码 0
真打包              → dsh-toolbox-0.1.0.tgz  82.4 KB
临时目录 npm i      → 退出码 0
import('dsh-toolbox') → 10 个导出
```

---

## 二、干净环境终验（无任何本地缓存污染）

```text
git clone（只含 HEAD 跟踪文件）      ok
npm ci                              退出码 0
npm i --no-save playwright          退出码 0（浏览器已在 %LOCALAPPDATA%\ms-playwright 缓存）
node --test
  ℹ tests 264   ℹ pass 264   ℹ fail 0   ℹ skipped 0
npm pack                            82.4 KB
npm i <tgz> + import                退出码 0，10 个导出
```

**0 skip 的前提**：Playwright 是**可选依赖**（`--no-save`，约 120 MB 浏览器）。只跑 `npm ci` 时那 2 条浏览器用例会 skip；装上才跑。这一点写在 README 里，不假装它默认存在。

---

## 三、P0 隐蔽缺陷（Pi 报告的前五条）

| Pi | 问题 | 修法 | 红灯 → 绿 |
|---|---|---|---|
| **P0-3** | journal 损坏被当成"空" → GC 把回收站里**仅存的用户文件**当孤儿删掉 | `journal.health()` **真的去读文件**：`ENOENT` 才算空，**解析失败 = corrupt**。GC 见 corrupt **一条不删**并返回 `corrupt:true`；`delete` 见 corrupt 直接 409 `journal-corrupt` | 3 红 → 绿 |
| **P0-1** | `done` 记录永不删除，journal 随删除次数线性增长 | purge 成功后**把 entry 从 journal 移除**（不留 `done` 墓碑）。测试：删 200 个会话，journal ≤ 20 条 | 1 红 → 绿 |
| **P0-2** | `protected` 条目不受容量约束 → 失败删除可填满硬盘 | `maxProtected`（默认 200）：满了 → **拒绝新删除 409 `trash-full`**；GC 返回 `overCapacity` | 2 红 → 绿 |
| **P0-4** | `removeTrashTree` 顶层 junction 会跟随并删掉目标 | 第一步 `lstat`：**是链接就拒绝**，再谈 realpath | 测试已覆盖 |
| **P0-5** | `heal()` 的 `deleting + moved` 分支没加锁 | 整个认领动作放进 `withLock(entry.id, …)` | 测试已覆盖 |

附带：`nonce` 形状校验（`[A-Za-z0-9_-]{16,64}`）、`removeTree` 遇 `ENOENT` 视为成功、journal 临时文件名带 pid。

---

## 四、P1/P2 扫尾

| 项 | 状态 |
|---|---|
| `finish` 对"trash 已不存在"幂等 | ✅ `ENOENT` 视为成功，不再卡在 `cleaned` |
| **journal entry 路径校验** | ✅ 从磁盘读回的 entry 必须：id 过 allowlist、`trashPath` 在 trashRoot 内；不合格 → `journal-corrupt` 拒绝执行 |
| journal 跨实例写 | ⚠️ **只做了唯一 temp 名**（不互相覆盖写坏）；**没有文件锁**，并发仍可能丢更新 |
| **双拼写幽灵行** | ✅ `cleanup` 清**所有拼写**；`list` 按 canonical id 去重 |
| audit 0600 | ✅ 写入后 `chmodSync(file, 0o600)`（Windows 忽略，POSIX 生效） |
| audit 轮转失败回退 | ✅ rename 失败 → **truncate**，绝不无界追加 |
| audit 定时 flush | ❌ **未做**（最后一个窗口的拒绝要等下一次调用才落盘） |
| **RPC list/heal 限流** | ✅ 无 id 的方法走 actor 窗口 |
| **actor key 被 id 挤掉** | ✅ actor 与 id 分成**两个有界 Map**（256 / 1024） |
| **gateway 不信 body 里的 principal** | ✅ 默认**拒绝**；身份必须由 `resolvePrincipal`（连接）注入；测试桩需显式 `allowPrincipalFromRequest: true` |
| **`pickResponse` 的 rows 上限** | ✅ `MAX_ROWS = 500` |
| `readAudit` 流式 | ❌ 未做（旋转后约 2×cap，可接受） |

---

## 五、仍未闭合（S4-c 与遗留）

| 项 | 说明 |
|---|---|
| **真实 `ctx.remote` 绑定** | 查实：`ctx.remote.<ns>` 由 **typert codegen** 生成（host service 描述 + 客户端 `inject`），不是运行时注册。属 S4-c |
| **宿主 feature 通电** | archive 的 probe/journal/audit/trash 还没有装进 profile 的宿主半边 |
| **审计落盘接线** | `createFileAudit` 有了，但宿主还没把它接上 |
| **HTTP 路由** | 默认关闭（`enabled: true` 才注册），**生产不挂** |
| `npm pack` 里的测试 | `prepack` 现在只构建；发布前应另跑一次全量（CI 职责） |

---

## 六、复现命令

```sh
npm test                                  # 264 项（Playwright 在位时 0 skip）
npm pack --dry-run                        # 34 files
node tools/prove-red.mjs                  # 存储矩阵 vs 旧 guard：14 红
node tools/prove-route-red.mjs            # 攻击矩阵 vs 旧路由：14 红
node tools/prove-service-red.mjs          # 服务矩阵 vs 墓碑服务：15 红
node tools/audit-archived-ids.mjs         # 真实归档集合审计
```

---

## 七、一句话

> 这一阶段被 Pi 打穿三次：同源校验信任攻击者的 `Host`、用墓碑冒充回收站、journal 损坏当空导致 GC 删掉用户文件。
> 现在：**传输层不新增未认证端点**，**删除是可恢复的 trash 状态机**，**日志有界且拒绝聚合**，**坏状态一律 fail closed**。
> 而它**还没有真正装上 DSH**——通电是 S4-c 的事。
