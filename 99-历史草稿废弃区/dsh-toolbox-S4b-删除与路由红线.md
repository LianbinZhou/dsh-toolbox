# dsh-toolbox S4-b · 删除与路由安全红线（先写测试，再写代码）

> 对象：archive 迁移（物理删除 + `/api/archive-manager/*` 路由）
> 原则：**任何一条红线没有红灯测试，不许写删除代码。**
> 我看到的未跟踪 `src/host/features/archive/paths.js` 和 `test/archive-paths-safety.test.mjs` 已经覆盖 S1–S8，且当前 10 项通过；
> 但下面的 R1–R7 仍然缺，尤其 R0（路由认证）和 R6（服务层流程）。

---

## R0（最高）删除路由必须有认证 + CSRF 防护

`/api/archive-manager/delete` 是 `webServer.register({kind:'exact'})`，
**exact 路由先于 API gateway 前缀匹配**；`webServer` 只禁止 wildcard 绑定，允许具体 LAN IP；
插件路由本身没有任何 `authorization` / `origin` / CSRF 检查。

后果：同一 LAN 的客户端，或恶意网页用 simple POST（`text/plain` + JSON body）打到
`http://127.0.0.1:<port>/api/archive-manager/delete`，就能物理删除会话。

**必须做**（至少满足一项，推荐全做）：

- 只允许 loopback peer（`req.socket.remoteAddress` 为 `127.0.0.1`/`::1`）；
- 校验 DSH 的认证会话/令牌，或把删除改走已认证的 `ctx.remote`/gateway 方法；
- 校验 `Origin` / `Sec-Fetch-Site` 同源；要求自定义头（触发 preflight），拒绝 `text/plain`；
- 拒绝无 `Content-Type: application/json` 的请求。

**测试**：无凭证 401/403；跨源 Origin 403；`text/plain` 400/415；合法请求 200；
`OPTIONS` 不泄露；非 loopback 无凭证拒绝。

---

## R1（最高）只允许删除**严格两级**的 session 目录

`<sessionsRoot>/<project>/<segment>`，且：

- `real !== rootReal`；拒绝 sessions root 本身；
- `real` 必须严格以 `rootReal + sep` 开头；拒绝 root 的父目录/祖先；
- **恰好两级**：`dirname(dirname(real)) === rootReal`；拒绝 session 目录里的任意子目录；
- 拒绝 root 的兄弟前缀（`/sessions-evil`）。

现有 `isInside` 把 root 自己算“inside”；`removeSessionDir` 已单独拒绝 root，但还需要覆盖**祖先**和**深度**。
**补测试**：`removeSessionDir(root,root)`、`removeSessionDir(base,root)`、`removeSessionDir(sessionChild,root)` 全部拒绝。

---

## R2（最高）symlink / junction：发现时拒绝，删除前再拒绝

现有测试覆盖“junction 指向 root 外”。还缺：

- junction/symlink 指向 **root 内另一个 session**：`findSessionDir` 不应返回它；`removeSessionDir` 不应删到目标；
- `lstatSync(dirPath).isSymbolicLink()` 必须拒绝（Windows junction 也按 link 处理）；
- 发现到删除之间重新 `lstat` + `realpath`，避免 TOCTOU；
- 目标必须是 directory，不是文件。

**测试**：root 内 junction → other session；`removeSessionDir` 拒绝，目标 session 仍存在；
外部 junction 已有；missing path 要 loud。

---

## R3（最高）session id 用 allowlist，不用 denylist

`isSafeSessionId` 现在拒绝 `/ \ ..`、Windows 保留字符、控制码、尾点/尾空格；这还不够。

建议 allowlist：

```js
/^(session-)?[0-9a-fA-F-]{8,64}$/   // 或严格的 UUID 形式
```

至少要拒绝：

- Windows 设备名：`CON`、`PRN`、`AUX`、`NUL`、`COM1..9`、`LPT1..9`（含带扩展名形式）；
- 内部空格、Unicode 分隔符/双向控制字符；
- `%2e%2e` 等编码（body 是 JSON，不自动解码；allowlist 直接挡掉）；
- 非字符串 / `String` 对象 / 超长；
- `canonicalSessionId(undefined)` 不应抛 TypeError（要么返回 null，要么由调用方先校验）。

`scrubProjcache` 必须复用同一个 `safeCacheKey`；不得 `join` 未校验 id。
**测试**：每个 hostile id 在 `isSafeSessionId`、`findSessionDir`、`scrubProjcache` 三处都被挡住。

---

## R4（最高）只删“已归档且非 live”的会话，并防重放

服务层必须：

- 只接受 `archivedSessionIds` 里的 id；**在删除前重新读取**持久状态，不能用请求里的“已确认”；
- 拒绝 live/正在运行的 session（`sessionPersistence`/registry 的 live 标记）；
- 建议要求一次性 confirm nonce / 二次请求，防重放和误点；
- 删除后再次删除返回 404/409（不是 500），幂等语义明确。

**测试**：未归档、live、重放、并发两次删除、归档状态在请求间变化。

---

## R5（高）顺序、失败与可恢复性

- 先解析目录 → **再删文件** → 最后清理归档/workspace/cache；
- 文件删除失败：归档状态必须不变；
- 文件已删、bookkeeping 失败：返回 warning，不能假装“什么都没发生”；
- 绝不允许先 unarchive 再删文件（旧 bug 已修，测试要锁）；
- 建议先原子 rename 到 `$DSH_HOME/storages/archive-trash/<id>`，bookkeeping 成功后再清空；
  至少提供恢复路径/明确不可恢复提示。

**测试**：在 removeSessionDir / unarchive / workspace / cache 四个点注入失败，断言状态与提示。

---

## R6（高）路由表面与输入

- 只允许 POST；其他方法 405；
- 强制 `Content-Type: application/json`，body 上限 64KB（旧 1MB 也可，但要明确）；
- JSON 必须是 object；`sessionId` 必须是 string；多余字段忽略；
- 限流（每 IP/会话）与审计日志（id、结果、时间，不记录敏感内容）；
- 错误响应不返回绝对路径/堆栈；
- 不注册 prefix 路由，避免吞掉别的 `/api/archive-manager/*`；
- 路由 disposer 必须在 `ctx.effect` 中正确注销（现有模式对）。

**测试**：GET/PUT/DELETE 405；坏 JSON 400；超长 413/400；限流；响应无路径。

---

## R7（高）`scrubProjcache` 的容器边界

即使 id 安全，也要保证：

- `perSessionDir` 的 realpath 必须在 `home/storages/session_projcache/sessions` 下；
- 只 unlink 普通文件，不 follow symlink；
- aggregate index 只删除 `tables.sessions` 的安全 key，不碰其他表；
- `home` 用 `resolve`，不要保留 `..`；
- 坏 JSON 原样保留，不重写。

**测试**：safe key 正常删；traversal 不删；index 其他表不变；symlink 文件不 follow。

---

## R8（流程）红灯先行

1. 先把 R1–R7 写成测试，跑在迁移前的 `paths.js`/旧 archive 上，确认**至少**：
   - root 删除 → 红；
   - scrub traversal → 红；
   - hostile id → 红；
   - route 无认证 → 红；
   - inside junction → 红。
2. 红灯数量必须记录（像 S3 的 `prove-red`），否则无法证明测试咬人。
3. 代码修到全绿后，再用真实临时树 + Windows junction + 真机路由测试复核。

---

## 结论

**S4-b 可以先写测试，但不要先写删除路由。**
最高优先级是 **R0 路由认证/CSRF**，其次是 **R1 严格两级 + R2 junction**；
这三条任何一条没锁死，都不要把 `removeSessionDir` 接到 HTTP 上。
