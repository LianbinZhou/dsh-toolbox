# 跟帖草稿（Comment）· 回复 mr2627999 的「冷会话 title 行不被采用」

> 用途：直接复制到那条官方 Discussion / Issue 下面回复，不要另开新帖。
> 基线版本：`@deepseek-ai/dsh` 0.2.1-rc.2，web profile，Windows 11，复查于 2026-10-20。
> 口头禅：**只补充、不重复**——他讲冷会话，我们补热会话。

---

Thanks for the write-up — your "cold session doesn't pick up the cached `title` row" case is real, and I think there is a **second, complementary half** of the same bug that explains the "new session stays 未命名 forever" symptom people usually hit first.

**Short version:** it is not only cold sessions. A session created *after* the page loaded never gets its title through the live path either, because the list's `upsert` mutation simply does not carry `title`. Ctrl+F5 fixes it only because a forced reload goes through the full `refreshList()` path instead.

### Observed behaviour

1. New Session → one message → 0.8 s later the title is generated and persisted (log proves it, see below).
2. Sidebar row keeps rendering the fallback label `未命名` (`session.untitled`).
3. **Ctrl+F5 → the title appears immediately.** A session created *after* the reload shows its title normally.
4. Every session that already existed when the page loaded keeps its title. Only post-load sessions are affected, until the next reload.

So the durable data is fine on both counts (log + persisted projection cache); only the live propagation to the row is missing.

### Evidence (all from the published 0.2.1-rc.2 build)

**(a) The title really was generated and logged** — `session-<id>.jsonl.zstd`, in order:

```
{"type":"session/title","seq":16,"time":1792471395251,"data":{"title":"这条我是做测试，会话条名称","messageSeqs":[8],"source":{"kind":"fallback"}}}
{"type":"session/title-llm-request","seq":17,"time":1792471395255,"data":{"titleProvider":"session-title-all-prompts-llm","messageSeqs":[8],"route":{"provider":"deepseek-account","model":"deepseek-flash"}}}
{"type":"session/title","seq":20,"time":1792471396056,"data":{"title":"会话条名称自动生成测试","messageSeqs":[8],"source":{"kind":"provider","provider":"session-title-all-prompts-llm","model":{"provider":"deepseek-account","model":"deepseek-flash"}}}}
```

The next prompt re-runs the provider (`messageSeqs:[8,28]`), so the "refresh as content advances" route works as designed.

**(b) The persisted projection cache holds it** — `~/.dsh/storages/session_projcache/sessions/session-<id>.json`:

```json
{"record":{"rows":{"title":{"ver":1,"seq":477,"val":"会话条名称自动生成测试"}}}}
```

**(c) It is not a "missing title" problem across the board** — of 84 listed sessions, the 43 with an empty title are **all** `blank: true` (never prompted). Not one non-blank session lacks a persisted title. The two rows showing `未命名` were exactly the two most recent — the ones still resident/attached when the list was pulled.

### Where the live path drops it

`@deepseek-ai/dsh-api-session-controller/lib/client.js`:

- `applyMutation()` (`:3622-3641`) — the `upsert` / `placeholder` branch that adds a freshly created session — merges `blank`, `running`, `agentAvailable`, `cwd`, `parentSessionId`, `origin`, `formatStatus` … **and never `title`**. There is no in-place field for the title to land in.
- `refreshList()` is only invoked from `handleConnected()` (`:3570-3574`) — i.e. on connect/reconnect, not periodically.
- `buildListSnapshot()` (`:3585-3603`) *would* re-render a title change (its dedupe compares `prev.title === entry.title`) — but only if a title change ever reaches the store.

The frames themselves should exist: the host broadcasts every projection change as `{type:"projection", sessionId, key, value, seq}` (`.../lib/index.js:1202-1210`) and the title projection is client-visible (`wire`) in `@deepseek-ai/dsh-session-title/lib/index.js:172-182`). But two mechanisms can discard it:

- `ProjectionValueStore` semantics (from its own doc comment): *"cached writes … only fill keys no sequenced row holds, and a baseline discards every cached row before it seeds"* — so a `cached` title can be wiped by a later baseline that omits `title`.
- `projectionsFor()` (`.../lib/index.js:2092-2101`) serves **attached** sessions from `sessionProjections.cachedSnapshot(session)`, which reads only already-materialized cells and *skips registrations with no cell* (`@deepseek-ai/dsh-session-projection/lib/index.js:157-176`) — while **cold** sessions are served from the persisted cache. That asymmetry is exactly the cold/hot split you and I are describing from opposite ends.

I could not see the browser console from the outside (the client logs `[session-controller] control stream failed:` there), so I can't say which of the two fires first. Either way the user-visible rule is: **a session created after page load only gets its sidebar title on the next full list refresh.**

### Suggested fix (pick one)

1. Carry `title` in the list `upsert` mutation (smallest change, fixes the hot-session half only).
2. Re-pull one row's projections when `api-session/added` arrives without a projection block.
3. Fall back to `cachedPredecessorTitle(header)` when the attached snapshot has no `title` cell — that removes the cold/hot asymmetry in one place.

---

### 中文摘要（给帖子里看中文的人）

**补充而不是重复**：你讲的「冷会话读不到缓存里的 title 行」成立；我这边撞到的是**同一根因的另一半——热会话**。

新建会话后，标题 0.8 秒就生成并落盘了（日志 `session/title` seq 16 是兜底、seq 20 是模型生成的正式标题；投影缓存里也有 `rows.title`），但侧栏那行一直显示「未命名」。原因在列表一侧：把新会话加进列表的 `upsert` 分支（`dsh-api-session-controller/lib/client.js:3622-3641`）**压根不合并 `title` 字段**；而全量 `refreshList()` 只在连接/重连时跑一次（`:3570-3574`）。所以新会话那一行没有任何"就地补标题"的通道。

**Ctrl+F5 之所以好使**，正是因为整页刷新走的是另一条路——全量重建列表，标题自然就带出来了。

另外两个可以佐证的细节：
- 84 条会话里 43 条空标题**全是空白会话**（`blank: true`，从没发过消息），没有一条"有内容却没标题"，说明生成侧无辜；
- 宿主对**常驻内存**的会话从 `cachedSnapshot(session)` 取标题（只读已算出的格子，没有就跳过），对**冷会话**才走持久缓存（`.../lib/index.js:2092-2101`）——这正好对应你说的冷会话问题。

建议官方在三处里挑一处补：① upsert 带上 `title`（最小改动）；② 收到 `api-session/added` 时补拉一次该行投影；③ 内存快照缺 `title` 时回退到 `cachedPredecessorTitle(header)`（一处消掉冷热不对称）。
