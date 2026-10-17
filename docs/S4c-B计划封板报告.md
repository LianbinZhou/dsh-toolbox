# S4-c · B 计划封板报告（WebServer 精确路由 + 进程内 Token）

> 日期：2026-10-17
> 结论：**A–D 四步全部完成**，304 / 304 绿、0 跳过；干净克隆复现；`npm pack` 90.1 KB 可装可 import。
> 唯一未做：真机 profile 安装（会掐断当前会话，需单独一轮）。

---

## 一、为什么走 B 计划

typert RPC 路线在单包结构下走不通，证据见 `docs/S4c-typert死胡同排查报告.md`：
`tsc -b` 项目图合法，但 `discover()` 恒为 0，`registrationHasSurface` 之上还需要「被引用项目各自是带 manifest 的包目录」——等于要求 monorepo 布局。

**不为一个闭源生成器改仓库结构**，改用官方扩展点 `ctx.webServer`：

```
GET  /api/archive-manager/token    下发进程内凭证（不删数据）
POST /api/archive-manager/delete   三件套校验后删除
```

---

## 二、A — 第 7 个开关

| 项 | 值 |
|---|---|
| key | `archiveHttpApi` |
| 标签 | 归档 HTTP 接口（实验性） |
| 默认 | **false（关闭）** |
| 归属 | `hostOnly: true` —— 不进客户端 feature registry |
| 卡片 | `SWITCHES.length` = **7**；`CLIENT_SWITCH_KEYS` 仍是 **5** |

`CONFIG_DEFAULTS` 作为纯数据导出，测试断言「发货默认关闭、其余保持 true」。

## 三、B — 开关驱动路由生命周期

`createArchiveHttpLifecycle({ readEnabled, registry, webServer, token, origins, onDelete })`

| 转换 | 行为 |
|---|---|
| off → on | **成对注册** token + delete |
| on → off | **成对撤销**（先拆删除路由，再拆凭证路由）+ **`registry.rotate()`**：旧 token 立即失效 |
| 注册中途失败 | 回滚，`registered:false` + `reason`，**不留半条** |
| 配置不变 | 幂等（不重复注册） |
| dispose | 全部撤下 |

宿主接线（`src/host/index.js`）：

```js
webServer = ctx.get('webServer')          // 可选：缺它只死归档
archiveHttp = createArchiveHttpLifecycle({ readEnabled: () => isOn(config, 'archiveHttpApi'), ... })
syncArchiveHttp('apply')                  // 冷启动
ctx.on('loader/volatile-update', () => syncArchiveHttp('volatile-update'))   // 热切换
```
`archiveOrigins(webServer)` 从**真实绑定端口**推出允许来源，绝不从请求头取。

## 四、C — 客户端 single-flight

`src/client/features/archive-client.js`

- token **只在闭包**：不进 localStorage / DOM / URL / window
- 并发 401 → **共享一次 refresh**（实测 5 个并发 = 总共 2 次 token 请求：1 初始 + 1 共享）
- 只重试**一次**；仍 401 → `refresh-required`，不循环
- 刷新失败也是稳定码；网络错误不抛异常
- `dispose()` 清 token + in-flight

## 五、D — 验证证据

### 干净克隆（无本地缓存）

```
git clone → npm ci（退出码 0）→ npm i --no-save playwright（0）
node --test → 304 tests / 304 pass / 0 fail / 0 skipped
npm pack   → dsh-toolbox-0.1.0.tgz  90.1 KB
临时目录 npm i → 退出码 0
import('dsh-toolbox') → 10 个导出，name = dsh-toolbox
```

### 真浏览器（Chromium）

```
✔ 跨源页面读不到 token（fetch 被 CORS 拦住，__r.read === false，body undefined）
✔ 同源页面能读到 token（功能成立）
✔ <img> 打 token 端点也拿不到内容
```

## 六、途中修掉的两个真问题

| 问题 | 真因 | 修法 |
|---|---|---|
| 双进程 journal 锁测试**全量时偶发红** | 子进程继承了 `node --test` 的 `NODE_TEST_CONTEXT`，行为变成测试 worker | spawn 时过滤 `NODE_TEST*` 环境变量 |
| token 端点的 Host 伪造用例一直"绿" | **undici 的 `fetch` 不允许伪造 `Host`**，测试根本没测到 | 改用 `node:http` 裸请求（rebinding 的真实形态） |

## 七、测试清单（304 项）

| 组 | 数量 | 覆盖 |
|---|---|---|
| token 端点 | 8 | no-store / 无 CORS / 拒代理头 / Host allowlist / 无副作用 / 轮换 / 长度先比 / 默认不注册 |
| host-feature 成对注册 | 7 | 正常 / 关闭 / 缺依赖 / 第二条失败回滚 / 第一条失败 / dispose 幂等 / disposer 抛错不外溢 |
| 第 7 开关 + 生命周期 | 8 | 7 个开关 / 默认关 / off 不挂 / on 成对 / 翻转撤销+轮换 / 幂等 / 失败不留 / dispose |
| 宿主接线 | 5 | 默认不挂 / volatile-update 实时开关 / 无 webServer 不炸 / teardown / origins 来源 |
| 客户端 single-flight | 7 | 不进 URL·全局 / 并发共享刷新 / 刷新失败不逐个重试 / 仍 401 不循环 / 网络错误 / dispose / 缓存复用 |
| 浏览器 | 2 | 跨源读不到 / 同源可读 |
| 其余 S4-b 安全矩阵 | 267 | 路径、探针、服务状态机、崩溃恢复、垃圾回收、审计、限流、RPC |

## 八、仍未做（明确列出）

1. **真机 profile 安装**：需要装进 `web` profile 并重启——**会掐断当前会话**，必须单独一轮。
2. **delete 的实际执行体**：`onDelete` 现在返回 `503 archive-service-not-wired`。`service.js` 的 trash 状态机已经写好且有 26 项矩阵，但还没接到这条路由上（需要 journal 目录、trash 根、审计落盘的真实路径配置）。
3. **客户端 UI**：面板还在旧插件里（DOM 硬插），尚未迁移到本容器并改调 token + delete 路由。

## 九、一句话

> B 计划把「门」焊死了：**凭证只发给同源页面、删除要三件套、开关默认关闭、关掉即销毁并作废凭证**。
> 门后面的房间（真正的删除执行体、UI）还没搬进去——这是下一轮的事，不是这一轮的遗漏。
