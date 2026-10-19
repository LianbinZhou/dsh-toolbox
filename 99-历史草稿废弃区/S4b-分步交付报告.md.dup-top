# S4-b 分步交付报告

> 项目：`dsh-toolbox`（web profile，本地 `link:` 安装）
> 阶段：S4-a（面板收纳）+ S4-b（历史归档：路径 / 路由 / 服务层 / Trash）
> 日期：2026-10-17
> 当前状态：**207 项测试全绿，0 跳过**；**delete 路由按 Pi 要求仍未挂到 `ctx.webServer.register`**
> 复现：`npm test` · `node tools/prove-red.mjs` · `node tools/prove-route-red.mjs` · `node tools/prove-service-red.mjs`

---

## 0. 总览

| 步骤 | 提交 | 红灯（改前） | 绿灯（改后） | 关键证据 |
|---|---|---|---|---|
| S4-a 面板收纳迁入容器 | `a3230d2` | — | 112 项 | 真机：`display:none` / 行高 0 / 关闭后样式表消失 |
| 路径安全矩阵 S1–S8 | `b1fc1ad` | 3 红 | 10 / 10 | 真实临时树 + 真实 Windows junction |
| Pi R1/R2/R3/R7 加严 | `a1bd0b8` | 9 红 | 13 / 13 | R2b：删 junction 会删掉**目标会话** |
| R0 路由攻击矩阵（v1） | `795e7f1` | 10 红 | 30 项 | 真实 `node:http` 靶机 |
| R0 硬化（v2，Pi 打穿后） | `f948b0a` | 3 P0 | 30 项 | Host 白名单 / 拒代理头 / 随机 token |
| R4/R5 状态机（v1 墓碑） | `5d2997b` | 6 红 | 13 / 13 | live / 竞态 / 并发 / 卡死 |
| **Trash 状态机（v2，Pi 否决后）** | `f05a2db` | **15 红** | 26 / 26 | durable claim + 原子 journal + restore |
| 真实 fs tri-state 探针 | `00663f0` | — | 8 / 8 | 只有完整无错遍历后才允许 `absent` |
| 真实浏览器 CORS | `00663f0` | — | 2 / 2 | Chromium，4 条攻击向量，`onDelete=0` |

**反向证据（证明测试会咬人）**：

```
存储矩阵（旧 guard）   27 项 → 14 红
攻击矩阵（旧路由）     16 项 → 14 红
服务矩阵（墓碑服务）   18 项 → 15 红
```

---

## 1. 步骤一 · S4-a：panel-menu 迁入容器

**手法**：602 行里**组件一字未改**，把旧的 `apply` 函数体原样包成 `applyBody(ctx)`，用一层 **Proxy 把 `ctx.effect` 转成 `env.track`**。因此 4 个副作用（2 个词典 + 2 个槽位）全部归容器所有。

**硬性验收标准**：藏侧栏的样式表不是注入到 `<head>`，而是**作为 React 节点画在触发按钮组件里**（`h('style', …)`）。所以关掉开关 → 槽位撤销 → 组件卸载 → `<style>` 随 DOM 消失 → 被藏的行立刻现身。

真机实测（用户自己在控制台跑）：

```
最高行高=0 | 容器display=none | 样式表=1     ← 开
样式表=0                                     ← 关
```

**Pi 的 P2（假测试）修正**：原来的 `layoutThrows` 测试只调 `mount()`，而 `mount` 根本不读 `layout`。改成真调 `collectPanels().run()` 后**立刻变红**——因为原代码是：

```js
ctx.layout || ctx.get('layout')   // 插件没 declare layout 时，属性访问本身就抛，|| 根本不执行
```

改成 `try/catch` 才真正降级。**假测试抓不到真 bug，真测试立刻抓到。**

---

## 2. 步骤二 · 路径安全矩阵

### S1–S8（`b1fc1ad`）红灯 3 条

| 用例 | 实际后果 |
|---|---|
| **S1 根目录自身** | `removeSessionDir(sessions, sessions)` **不抛错，把整个 sessions 树删了** |
| **S2 穿越 id** | `scrubProjcache(base, ['../../outside/marker'])` **删掉了 home 外的文件** |
| **S3 恶意字符** | `x\0y` 等控制字符放行 |

### R1/R2/R3/R7（`a1bd0b8`）红灯 9 条

最狠的一条是 **R2b**：`removeSessionDir` 收到一个指向**另一个会话**的 junction，会**把那个真实会话删掉**。

修法：严格两级（`dirname(dirname(real)) === rootReal`）、`lstat` 拒链接、uuid allowlist、`canonicalSessionId` 不抛。

**R4-10 用真实数据验证**：

```
~/.dsh/sessions：100 个会话目录（session-uuid 86 · bare-uuid 14）
不符合 allowlist 的：0
```

---

## 3. 步骤三 · R0：路由攻击与硬化

### 3.1 第一版（`795e7f1`）——被 Pi 打穿

旧路由复刻成真实 `node:http` 靶机，**10 条攻击全部 200 并执行删除**：跨源、无凭证、`text/plain`、GET/DELETE、80 KB body、坏 JSON……

第一版防线（七道门）被 Pi 一条 raw 请求打穿：

```http
POST /api/archive-manager/delete
Host: evil.example
Origin: http://evil.example
x-dsh-toolbox: 1
```

返回 **200 并把会话删了**。根因：**用请求里的 `Host` 去验证请求里的 `Origin`**——等于让攻击者自己签通行证。

### 3.2 第二版（`f948b0a`）

| Pi | 修法 |
|---|---|
| P0-1 Host / DNS rebinding | origin 白名单**从 `server.address()` 的真实监听地址推导**；宿主挂载时必须显式传入；Host 不在白名单 → 403 |
| P0-2 loopback 不是认证 | `X-Forwarded-For / Forwarded / X-Real-IP / X-Forwarded-*` 任一出现 → 403，除非显式 `trustProxy` |
| P0-3 常量头不是凭证 | 改成 **32 字节随机 token**（64 hex），逐字节比较；缺失/短/错 → 401；常量头明确降级为 CSRF 预检触发器 |
| P1-5 路径泄露 | service 的 `error`/`warning` 原文**永不**回传，只回白名单码 |
| P1-6 测的不是生效的那份 | 同一份 `createDeleteHandler` 既跑靶场也跑 `webServer.register`；集成测试用 fake webServer 捕获 route 再用真实 HTTP 打它 |
| P1-7 只比 host | 改成完整 origin（scheme + host + port） |
| P1-4 假 CORS | 真浏览器（见 3.3） |

### 3.3 真实浏览器 CORS（`00663f0`）

装了 Playwright + Chromium headless shell（118 MB，走代理），四条真实向量，断言**服务端 `onDelete` 计数 = 0**：

```
✔ no browser vector can delete without the token
✔ the CORS preflight is answered without granting access
```

向量：`<form>` 式 `text/plain`、`fetch(mode:'no-cors')`、带自定义头的预检请求、sandbox iframe（`Origin: null`）。
预检响应里**没有** `ACAO` / `ACAC` / `Access-Control-Allow-Private-Network`。

---

## 4. 步骤四 · R4/R5：从墓碑到真正的 Trash

### 4.1 第一版（`5d2997b`）墓碑方案——被 Pi 否决

它解决了并发与重放（per-id 锁、二次校验、稳定 reason 码），但 Pi 指出 10 个漏洞，最关键三条：

- **D1** `probe` 返回 `undefined` 同时代表「不存在 / 权限错误 / 是链接 / 根不可用」，于是**权限错误会把真实会话的归档清掉**；
- **D4** `pendingCleanup` 只在内存，进程重启后幽灵数据永远清不掉；
- **D7** 目录身份 TOCTOU：查到目录后、删除前被别人换成另一个真实会话，会把无辜会话删掉。

### 4.2 第二版（`f05a2db`）Trash 状态机

```
archived --claim(deleting)--> deleting --rename--> trashed
         --unarchive/workspace/cache--> cleaned --purge--> done
```

| Pi | 修法 |
|---|---|
| D1 | `probe` 改 **tri-state**：`present / absent / unsafe / error`；只有 `absent` 允许 cleanup-only |
| D2 | **durable claim 先落盘**（`deleting` + nonce + dev/ino/realpath），再做二次校验 |
| D3 | `heal`/`unarchive` 走与 `delete` 相同的 per-id 锁 |
| D4 | **`archive-journal.json` 原子写**（temp + rename），新实例能接上旧工作 |
| D5 | unarchive 幂等：已清即成功 |
| D6 | cleanup-only 前**再查一次 live** |
| D7 | 移动前重新比对 `dev/ino`，不一致 → `identity-changed` 并释放 claim |
| D8 | **claim 本身就是跨实例锁**：第二个实例看到 `deleting` → 409 |
| T1 | 同卷校验，跨卷**拒绝**，绝不 copy+delete |
| T3 | trash 条目名 = 随机 nonce，路径不含 session id |
| T5/T6 | 四个 phase 全部落盘；journal 原子替换 |
| T8 | `restore()` 把 trash 里的目录搬回原路径 |

对照同一套 18 项矩阵：**墓碑 15 红，Trash 26 绿。**

### 4.3 真实文件系统 tri-state（`00663f0`）

之前 tri-state 只有测试桩。`probe.js` 是生产实现，8 项真实树测试，核心是 **`absent` 的门槛**：

| 场景 | 结果 |
|---|---|
| 真有会话 | `present`（带 dev/ino/realpath） |
| 真没有 | `absent` |
| sessions 根不存在 / 是文件 | `error` |
| 会话目录是 junction | `unsafe: link` |
| 项目目录是 junction | 跳过，真实项目里的会话仍找到 |
| **某个项目读不了（ENOTDIR）** | `error` —— 会话可能就藏在那里 |

**只有完整、无错地走完整个 sessions 树之后，才允许说 `absent`。**

---

## 5. 复现命令

```sh
npm test                          # 207 项，含真实 Chromium
node tools/prove-red.mjs          # 存储矩阵 vs 旧 guard：应 14 红
node tools/prove-route-red.mjs    # 攻击矩阵 vs 旧路由：应 14 红
node tools/prove-service-red.mjs  # 服务矩阵 vs 墓碑服务：应 15 红
```

浏览器用例需要 Playwright，**没装就 skip，不会假装通过**：
`npm i --no-save playwright && npx playwright install chromium`

---

## 6. 仍未闭合（诚实清单）

| 项 | 状态 |
|---|---|
| **T7** bookkeeping 失败保留 trash + heal 重试 | 部分（保留 trash + heal 有；没有「trash 保留多久」的策略） |
| **T9** trash 的 TTL / 容量 / GC / 手动 purge | **没有** |
| **T10** trash 自身删除时的 junction/嵌套防护 | **没有**（`removeTree` 目前是注入的） |
| **R5-11 崩溃矩阵** | 只覆盖 2 个点（claim 残留、pending 重连），四个崩溃点未逐一模拟 |
| **R5-14 权限** | 用 ENOTDIR 代理了「读不了」，真实 EACCES / EBUSY 未测 |
| **token 交付通道** | **没有**（必须与客户端 UI 一起做，不能进 URL/日志） |
| **路由挂 `ctx.webServer.register`** | **按 Pi 要求未挂** |
| R4-7 / R4-8 / R4-9 / R4-13 | 未测（durable 优先、脏元素、双拼写、nonce） |

---

## 7. 一句话

> 这一阶段被 Pi 打穿两次：第一次是同源校验拿攻击者的 `Host` 当权威，第二次是用墓碑冒充回收站。
> 现在的形态是：**传输层只认"我真实监听的 origin + 我这一进程刚生成的 token + 没经过代理的 loopback"**，
> 服务层是**"claim 落盘 → 核对身份 → 同卷 rename 进 trash → 清标记 → 清 trash"**，每一步都能重启恢复、也能让用户 restore。
> 但在 T9/T10 与完整崩溃矩阵补上之前，**这套东西仍然不接 HTTP**。
