# dsh-toolbox —— 大一统容器 · 技术方案

> 版本：方案 v1（**待你审阅，尚未动工**）
> 日期：2026-10-17
> 目标：把 6 个自建插件合并成 **1 个包**，插件页只留一行 `dsh-toolbox`，进去后有一个官方设置面板，列出 6 个子功能，每个带开关。
> 前置结论：**技术上可行**，三道关卡都有解；但有 5 个未知点必须在 MVP 里实测，其中 1 个可能决定成败。

---

## 零、先说三个关键判断

| 判断 | 依据 |
|---|---|
| **「一个包」是必须的**，不是选择 | DSH 的 `dsh.client` 是**包级**声明，客户端模块的 `id` 必须等于包名 → 一个包只能有一个浏览器半边 |
| **「动态加载」只能是「动态挂载」** | 浏览器半边是单个文件一次性加载，没法按需从网络拉子模块。所以开关控制的是 **mount / unmount**，不是 lazy import |
| **开关应该交给 DSH 官方设置系统** | 你的插件行可以 `export const Config`，官方会把它投影成表单，自动出现在插件页；**不用 `~/.dsh/config.json`** |

---

## 一、目录结构（一个新仓库，一个包）

```
dsh-toolbox/
├── package.json                  ← 唯一的包名，声明 bundle + client
├── cordis.patch.yml              ← 插入 1 行 dsh-toolbox + session-query-sqlite 的常驻 patch
├── index.js                      ← 宿主入口：容器 + Config schema（6 个开关）
├── client.js                     ← 客户端入口（产物，tools/concat.mjs 生成，提交进仓库）
├── icon.svg
├── locale/
│   ├── en.json                   ← meta.title / meta.description
│   └── zh.json
├── src/
│   ├── shared/
│   │   ├── features.js           ← ★ 单一真源：6 个功能的 id / 中文名 / 默认值
│   │   └── config-schema.js      ← 由 features.js 生成 Config（宿主用 + 设置面板用）
│   ├── host/
│   │   ├── index.js              ← 宿主容器：按开关挂载/卸载
│   │   └── features/
│   │       ├── session-search.js ← session_search 工具（从 dsh-session-search 迁移）
│   │       └── archive.js        ← webServer 路由（从 archive-manager 迁移）
│   └── client/
│       ├── index.js              ← 客户端容器：读开关、reconcile、dispose 兜底
│       ├── registry.js           ← 功能注册表 + 挂载调度器
│       └── features/             ← ★ 序号 = 拼接顺序
│           ├── 01-quote-reply.js
│           ├── 02-draft-saver.js
│           ├── 03-panel-menu.js
│           ├── 04-archive-panel.js
│           └── 05-plugin-zh.js
├── tools/
│   └── concat.mjs                ← 20 行，零依赖：src/client/** 拼成 client.js
├── test/
│   ├── registry.test.mjs         ← 开关 → mount/unmount 调度
│   ├── concat-fresh.test.mjs     ← 产物是否与源码同步（治"忘了 build"）
│   ├── quote-reply.test.mjs
│   ├── draft-saver.test.mjs      ← 迁移原有 40 项
│   ├── plugin-zh.test.mjs        ← 迁移原有 9 项
│   └── session-search.test.mjs
├── README.md
├── LICENSE
└── .gitignore
```

**为什么源文件分家、但产物是单文件**：见第五节。一句话——真正的单文件会把 5 个功能塞进一个约 100 KB 的 `client.js`，改一行要在大文件里翻；而 20 行拼接脚本能达到「源文件清爽 + 运行时单文件 + 零依赖打包器」三个目标同时满足。

---

## 二、问题一：客户端路由

### 2.1 核心思路

浏览器产物只有**一个** `client.js`，它注册**一个**懒工厂：

```js
window.__ModuleLoader__.load({
  id: 'dsh-toolbox',              // 必须等于包名
  factory(require) {
    const React = require('react');
    return {
      inject: ['slots', 'locale', /* 下面第四节给了完整清单 */],
      apply(ctx) { /* 容器：见 2.3 */ },
    };
  },
});
```

**「动态」发生在 `apply` 里**：容器读开关，逐个决定要不要 `mount` 子功能。代码全在包里，只有**注册与副作用**是条件性的。

关掉的功能：不注册 slot、不挂 MutationObserver、不监听事件、不建 React 树 → **零运行时开销**。

### 2.2 功能契约（整个设计的地基）

每个子功能必须是一个**带对称清理**的对象：

```js
// src/client/features/01-quote-reply.js（拼接时按序号顺序执行）
__toolbox.defineFeature({
  id: 'quote-reply',
  title: '划词引用',
  defaultOn: true,

  /**
   * 挂载。返回的必须是"把所有副作用收回"的函数。
   * env 是容器统一发的小工具包，不让功能直接摸 ctx 的私有面。
   */
  mount(ctx, env) {
    // 原 dsh-quote-reply 的 apply 内容搬进来
    const offMenu = ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'toolbox.quote.menu', order: 200 }, MenuEntry));

    const offSink = ctx.slots.inject('conversation.input.overlay', () => {
      const off = env.registerSink(handleQuote);
      return () => { off(); };
    });

    return () => { offSink(); offMenu(); };
  },
});
```

> **硬规矩**：`mount` 里拿到的每一个 disposer 都必须被收集并返回。做不到这一点的功能**不能进容器**——因为开关的"关"就是靠它。

### 2.3 容器（真正的调度逻辑）

```js
// src/client/index.js
apply(ctx) {
  const live = new Map();          // featureId -> dispose
  const errors = new Map();        // featureId -> 上次挂载失败原因

  const env = {
    React, h,
    t: (key) => dict[key] ?? key,
    registerSink,                  // quote-reply 与 composer 之间的交接
    log: (msg) => console.info('[dsh-toolbox] ' + msg),
  };

  /** 把「期望的开关状态」对齐到「现实已挂载状态」——只动差集 */
  function reconcile(next) {
    for (const f of __toolbox.features) {
      const want = next[f.id] !== false;
      const mounted = live.has(f.id);

      if (want && !mounted) {
        try {
          live.set(f.id, f.mount(ctx, env) ?? noop);
          errors.delete(f.id);
        } catch (err) {
          // 一个功能崩，不影响其它功能 —— 这是容器存在的意义之一
          errors.set(f.id, err);
          console.error('[dsh-toolbox] mount failed: ' + f.id, err);
        }
      } else if (!want && mounted) {
        try { live.get(f.id)(); } catch (err) { console.error(err); }
        live.delete(f.id);
      }
    }
  }

  // 1) 先按默认值铺一遍（不阻塞首屏）
  reconcile(DEFAULTS);

  // 2) 读到真实开关后对齐
  readSwitches(ctx).then(reconcile).catch(() => {});

  // 3) 订阅变更（官方设置镜像 / 事件）
  const offWatch = watchSwitches(ctx, reconcile);

  // 4) 兜底：容器被卸载时全部收回
  ctx.effect(() => () => {
    offWatch();
    for (const [, dispose] of live) { try { dispose(); } catch {} }
    live.clear();
  }, 'toolbox: dispose all features');
}
```

### 2.4 六个功能各自的挂载形态

| 功能 | 挂到哪里 | 关闭时收回什么 |
|---|---|---|
| `quote-reply` | `shell.overlay` + `conversation.input.overlay` | 两个 slot 注册 + 选区监听 |
| `draft-saver` | `conversation.input.overlay`（提示条） | slot 注册 + `Storage.prototype` 的 patch（要还原原函数） |
| `panel-menu` | 侧栏（`ui-sidebar` 相关 slot） | slot 注册 + 它注入的图标/菜单 |
| `archive-panel` | 侧栏 + 官方「历史归档」入口区 | slot 注册 + 面板轮询定时器 |
| `plugin-zh` | 无 slot（纯 DOM 观察） | MutationObserver + 右下角提示条 |
| `session-search` | **宿主侧**，不是客户端 | 见第三节 |

> ⚠️ `draft-saver` 是唯一**改全局对象**的功能（patch `Storage.prototype`）。它的 `dispose` 必须把原函数换回去，否则"关掉"只是假装关掉。这一条要写进测试。

---

## 三、问题二：依赖注入与覆盖

### 3.1 `dsh.client.inject`：取并集，代价接近于零

6 个插件的 `inject` 加起来是：

```json
"inject": [
  "@deepseek-ai/dsh-client-ui-conversation",   // draft-saver, quote-reply
  "@deepseek-ai/dsh-client-ui-sidebar",        // panel-menu
  "@deepseek-ai/dsh-client-ui-workspace",      // archive-manager
  "@deepseek-ai/dsh-client-runtime",           // archive-manager
  "@deepseek-ai/dsh-client-connection",        // archive-manager
  "@deepseek-ai/dsh-client-locale"             // 国际化（官方要求 UI 文案走 locale）
]
```

**结论：合并没有风险。** 理由：这 6 个全是 DSH 网页外壳本来就会加载的核心模块，`inject` 只是"等它们就绪"，不增加下载量、不改变加载时机。原来 `immediately: true` 那 4 个的行为也保持一致。

> 真正的冲突风险不在 `inject`，在 **slot 竞争**（见 3.2）。

### 3.2 slot 冲突矩阵（唯一需要显式约定的地方）

| slot | 谁用 | 会不会打架 | 处理 |
|---|---|---|---|
| `shell.overlay` | quote-reply | 否 | 独占，`order: 200` |
| `conversation.input.overlay` | quote-reply（sink）+ draft-saver（提示条） | **会共存** | id 必须不同、`order` 拉开（sink 300 / 提示条 320） |
| 侧栏面板区 | panel-menu（收拢入口）+ archive-panel（新增入口） | ⚠️ **有顺序依赖** | **约定：archive-panel 先注册，panel-menu 后收拢**。拼接序号 `03` 在 `04` 之前就是靠这个顺序，但更稳的做法是给 archive 的入口一个明确的 `order`，让 panel-menu 只收拢 `order < 自己的` 的入口。**这条要写进 README 的契约说明** |

### 3.3 `session-query-sqlite` 的「覆盖」——真相和我一开始以为的不一样

**它不是 `overrides` 字段，而是「用同 id 打一层 patch」。** 实测 `dsh-session-search/cordis.patch.yml`：

```yaml
- id: session-query-sqlite
  config:
    path: 'C:\Users\zhou0\.dsh\storages\session-search.db'
    openAt: first-search

- insert:
    - id: tool-session-search
      name: '@local/dsh-session-search'
      config: {}
```

官方文档对这件事有一句关键话：**「匹配到的 override 会整体替换 config」**。

**含义**：patch 层是**静态**的，运行时开关是**动态**的 —— 这两套机制不能互相控制。

**决策（建议）**：让这条 patch **常驻**，理由是它只做两件无害的事：
- 把官方 `sessionQuery` 的全文检索打开（`openAt: first-search`）
- 指定持久索引路径

关掉 toolbox 的「会话搜索」功能后，官方那行仍然"能搜、但没有给 AI 的工具"——这**无害甚至更好**（侧栏搜索更准，AI 不多一个工具）。

**但必须在设置面板里把这条说清楚**，否则会让人以为开关能控制一切：

> 「会话搜索」开关只控制**给 AI 的 `session_search` 工具**，不控制侧栏搜索是否走全文索引。

**兜底方案**（如果将来确实要能关）：把这条 patch 拆成**第二个独立小 bundle**（`dsh-toolbox-search-seam`），装/卸即开关。**用 bundle 当开关**，这是唯一能真正开合 patch 层的办法。MVP 不做。

### 3.4 宿主侧的开关怎么生效

宿主入口长这样（官方文档规定的三种形式之一，**不能混用**）：

```js
// index.js
export const inject = ['tools', 'webServer', 'settings'];   // 需要什么写什么
export const Config = buildConfigSchema();                  // 见第五节

export function apply(ctx, config) {
  // config 就是设置面板里那 6 个开关的当前值
  const disposers = [];

  if (config.sessionSearch !== false) {
    disposers.push(installSessionSearchTool(ctx));
  }
  if (config.archivePanel !== false) {
    disposers.push(installArchiveRoutes(ctx));
  }

  ctx.effect(() => () => disposers.forEach((d) => { try { d(); } catch {} }),
             'toolbox: host features');
}
```

`ctx.tools.register(...)` 的返回值本身就是 disposer → **开关关掉时工具能真的消失**。

---

## 四、问题三：测试与构建

### 4.1 先给个好消息：archive-manager 的构建是「假构建」，删掉零风险

实测文件大小：

| 文件 | 大小 |
|---|---|
| `src/host/index.js` | 18509 B |
| `lib/index.js` | **18509 B** ← 完全一样 |
| `src/host/paths.js` | 6259 B |
| `lib/paths.js` | **6259 B** ← 完全一样 |
| `src/client/client.js` | 17912 B |
| `lib/client.js` | 17546 B ← 只差 366 B |

**宿主侧零转译（纯复制），客户端侧只差 366 字节（大概是去注释）**。所以：
- `build.mjs` / `build-client.mjs` / `lib/` 全部删除
- 宿主代码直接进 `src/host/features/archive.js`
- 客户端代码直接进 `src/client/features/04-archive-panel.js`

**收益**：它那个「改源码要手动再拷一次」的老毛病自动消失。

### 4.2 为什么保留一个 20 行的拼接步骤

| 方案 | 优点 | 缺点 |
|---|---|---|
| **A. 真·单文件**（手写一个 `client.js`） | 零工具链，最符合你的原话 | 5 个功能约 **100 KB 挤在一个文件**；改一行要在大文件里翻；功能边界靠注释维持 |
| **B. 20 行拼接**（推荐） | 源文件一个功能一个文件；产物仍是单文件；零依赖、零打包器 | 多一步 `node tools/concat.mjs` |
| C. esbuild 打包 | 最专业 | 你明确说要去掉构建 |

**推荐 B**。`tools/concat.mjs` 就这么点东西：

```js
// tools/concat.mjs —— 零依赖，20 行
import { readdir, readFile, writeFile } from 'node:fs/promises';
const HEAD = ';(function(){ const __toolbox = { features: [], defineFeature(f){ this.features.push(f); } };';
const TAIL = ' window.__TOOLBOX_FEATURES__ = __toolbox.features; })();';
// 再拼上容器本体 src/client/index.js + 按序号排好的 features/*.js + 模块注册尾巴
```

**拼不进去的坑提前说**：每个功能文件是"往 `__toolbox` 注册"的普通脚本，**不能用 ESM `import/export`**（浏览器产物是 IIFE，没有模块解析）。所以：
- 源文件用 `export` 语法的话就得靠打包器 → 与"零依赖"冲突
- **约定：`features/*.js` 只写 `__toolbox.defineFeature({...})`，不写 import/export；需要的工具从 `env` 拿**

### 4.3 `npm test` 怎么跑

```json
"scripts": {
  "test": "node --test test/",
  "build": "node tools/concat.mjs",
  "prepublishOnly": "npm run build && npm test"
}
```

全部用 Node 自带的 `node:test`（你现有的测试已经是这个写法），**零测试框架依赖**。

**测什么**（这是关键，不是形式主义）：

| 测试 | 断言什么 | 为什么必须有 |
|---|---|---|
| `registry.test.mjs` | 给定 6 个假功能 + 一组开关，`reconcile` 调用了正确的 `mount`/`dispose` 次数；重复 reconcile 不重复挂载；某功能 `mount` 抛错时其它功能仍然挂上 | 这是整个容器的核心逻辑，不测等于没写 |
| `concat-fresh.test.mjs` | 重新拼一次，与仓库里的 `client.js` **逐字节比对** | **直接治 archive-manager 那种"改了源码忘了构建"的老毛病** |
| `draft-saver.test.mjs` | 迁移原有 40 项；额外加一条：`dispose` 之后 `Storage.prototype.setItem` 必须**恢复成原函数** | 它改全局对象，不恢复就是"假关闭" |
| `quote-reply.test.mjs` | 迁移原有测试；额外加：mount 注册了 2 个 slot，dispose 后 2 个都注销 | slot 泄漏检测 |
| `plugin-zh.test.mjs` | 迁移原有 9 项 | 词典质量 |
| `session-search.test.mjs` | 开关开 → 调用了 `ctx.tools.register`；开关关 → 调用了它的 disposer | 宿主侧开关的真实性 |

**怎么驱动 `client.js`（单文件产物）**：跟你 `dsh-plugin-zh` 现在的做法一样 —— 塞一个假的 `window`（含 `__ModuleLoader__`）再 `import` 产物，从 `window.__TOOLBOX_FEATURES__` 把功能们取出来测。**不需要真浏览器、不需要 jsdom**。

### 4.4 渲染类的功能怎么测

`quote-reply` / `panel-menu` / `archive-panel` 依赖 React 和 slot。测试**不渲染 DOM**，只验三件事：

1. `mount` 时调用了预期的 `ctx.slots.inject(...)` / `ctx.slots.register(...)`（用假的 `ctx.slots` 记录调用）
2. 返回的 disposer 把所有注册都收回了
3. 组件函数本身能被调用且返回 React 元素（假的 React：`{ createElement }`）

真实视觉效果**只能你在页面上验**。这点我会在交付报告里明说，不会拿"装上了"冒充"好看了"。

---

## 五、开关存哪（你的直接提问）

### 答案：DSH 官方设置系统接管，**不是** `~/.dsh/config.json`

| 环节 | 用官方什么 |
|---|---|
| 开关的定义 | 宿主入口 `export const Config = Schema.object({...})`（schemastery） |
| 设置面板 | 官方 `settings` 服务把 schema **投影成表单**，出现在「插件管理 → dsh-toolbox → 配置」 |
| 落盘 | **profile 的配置层**（`~/.dsh/profiles/web/cordis.patch.yml` 里 `dsh-toolbox` 那一行的 `config:`）；写由官方 `settings` / `configEditor` 负责，**我们不自己写文件** |
| 客户端读取 | `ctx.remote.settings`（`describe()` 拿到带值快照）+ 官方客户端设置镜像 |
| 变更通知 | 官方事件 `settings/document-updated`（`ns, revision`）→ 容器 reconcile |

**为什么不用 `~/.dsh/config.json`**：那等于自造一套配置系统，代价是——
- 面板要自己写（白丢官方渲染的表单，也就丢掉了 `dsh-plugin-zh` 想解决的"看得懂"问题）
- 多设备/多 profile 不一致
- 官方升级改了配置模型，我们得跟着改

**收益**：面板免费、中文免费、schema 校验免费、`Schema.i18n()` 还能把字段说明也做成中文。

**字段说明中文化的写法**（官方 `Schema.prototype.i18n` 支持）：

```js
export const Config = Schema.object({
  quoteReply:   Schema.boolean().default(true),
  draftSaver:   Schema.boolean().default(true),
  panelMenu:    Schema.boolean().default(true),
  archivePanel: Schema.boolean().default(true),
  pluginZh:     Schema.boolean().default(true),
  sessionSearch: Schema.boolean().default(true),
}).i18n({
  zh: {
    quoteReply:   '划词引用：划选对话文字后浮出「引用 / 复制」',
    draftSaver:   '草稿保险箱：没发送的内容不会丢',
    panelMenu:    '面板收纳：把侧栏面板入口收进一个菜单',
    archivePanel: '历史归档：列归档会话、一键恢复、删除',
    pluginZh:     '插件汉化：插件说明显示中文',
    sessionSearch:'会话搜索：给 AI 一个 session_search 工具（不影响侧栏搜索）',
  },
});
```

> ⚠️ `i18n` 的确切形状需要在 MVP 里对着运行时确认一次（我读到 `Schema.prototype.i18n(messages)` 存在，但消息结构要实测）。

---

## 六、MVP 范围与验收标准

按你说的，先拿**最难的组合**打通：`quote-reply`（纯客户端）+ `session-search`（纯宿主）。这个组合覆盖了「客户端开关」和「宿主开关」两条完全不同的路径，选得很准。

### 阶段 0：骨架 + 开关机制（MVP）

**做**：
- 新仓库 `dsh-toolbox/`，上面那个目录结构
- `index.js` 宿主容器 + `Config`（6 个开关全定义，但只前 2 个有真实现，其余挂占位）
- `client.js` 容器 + `tools/concat.mjs`
- 迁移 `quote-reply` → `01-quote-reply.js`
- 迁移 `session-search` → `src/host/features/session-search.js`
- `cordis.patch.yml`（含 `session-query-sqlite` 常驻 patch）
- 6 个测试文件

**验收标准（缺一不算过）**：

| # | 验收项 | 判定方式 |
|---|---|---|
| 1 | 插件管理页只多出**一行** `dsh-toolbox` | 你在页面看 |
| 2 | 点进去有**配置卡片**，6 个开关都在，说明是中文 | 你在页面看 |
| 3 | 关掉「划词引用」→ 划词浮层**立刻消失**（不刷新页面） | 你在页面点 |
| 4 | 打开「划词引用」→ 浮层立刻回来 | 你在页面点 |
| 5 | **关掉「会话搜索」→ 我调 `session_search` 调不到**（这条是最大的未知点，见第七节） | 我在会话里实测 |
| 6 | `npm test` 全绿 | 我跑 |
| 7 | 关掉任一功能后，**另一个功能照常工作**（互不牵连） | 你在页面点 |

### 阶段 1：迁移其余 4 个
`draft-saver` → `02`、`panel-menu` → `03`、`archive-panel` → `04`、`plugin-zh` → `05`。
每迁一个，跑一次全量测试 + 你在页面点一遍开关。

### 阶段 2：收尾
- 老 6 个仓库**归档保留**，README 顶部加一行"已并入 dsh-toolbox"
- `dsh-plugin-zh` 还没推过 GitHub → **直接并进来，不单独建仓库**（少一个仓库）
- 写 README + 迁移对照表

### 工作量估计

| 阶段 | 估计 |
|---|---|
| 阶段 0（MVP） | 1 个工作日（含你验收的来回） |
| 阶段 1 | 1 个工作日 |
| 阶段 2 | 半天 |
| **合计** | **约 2.5 个工作日** |

---

## 七、5 个必须实测的未知点（风险清单）

按"会不会推翻方案"排序：

| # | 未知点 | 如果假设错了 | 兜底 |
|---|---|---|---|
| **1** | **翻转开关能否不重启就影响宿主行**（`sessionSearch`） | 如果宿主行不重建，`session_search` 工具关不掉 | 退而求其次：宿主功能改成「工具注册了，但 `tools/pre-execute` 里按开关直接拒绝」——**工具还在，但一调用就说"已关闭"**。功能等价，体验略差 |
| 2 | 客户端怎么拿到 Config（`ctx.remote.settings` 还是 `@deepseek-ai/dsh-client-ui-settings` 的镜像） | 拿不到值 → 开关不生效 | 客户端把开关值通过**宿主注入的初始值**下发；或用 `ctx.config`（若客户端可见） |
| 3 | slot 运行时注销后能否干净移除（无残留 DOM） | 关掉后元素还挂在那 | 功能内部再包一层：`mount` 返回的 dispose 里先卸载自己的根元素 |
| 4 | `panel-menu` 收拢 `archive-panel` 入口的顺序 | 归档入口没被收进去 | 显式给 `order` + panel-menu 只收拢比自己小的 order |
| 5 | `plugin-zh` 的 DOM 改法是否该重构 | 官方文档**明确不建议读别人的 DOM**（`ui-plugin.md`）；它有被 DSH 改版打脸的风险 | 保留现状（它已经在跑），但标注为技术债；长期方向是走官方 locale 注入 |

> **第 1 条是真正的生死线**。我建议 MVP 第一天就只做这一件事：装一个最小包，`Config` 里放一个布尔，`apply` 里按它注册/注销一个假工具，翻转开关看工具在不在。**半天内就能知道方案要不要改。**

---

## 八、和官方文档对齐的三条纪律

写代码时会被这几条约束（`references/ui-plugin.md` 明确要求）：

1. **工厂里不能有副作用**：所有注册都放 `apply` + `ctx.effect`/`ctx.on`，并返回清理函数
2. **不改应用根、不往 `document.body` 追加第二个应用**：我们只用 slot 和既有的浮层
3. **UI 文案走 Client locale 服务**：容器自己的界面文字（提示条之类）要走 `ctx.locale`

> 第 3 条意味着：`plugin-zh` 里那些写死的中文提示，合并时要改成 `ctx.locale.register` + `bind`（你现有 `dsh-quote-reply`、`dsh-draft-saver` 已经是这个写法，照着搬就行）。

---

## 九、需要你拍板的 4 件事

1. **构建**：接受 **20 行拼接脚本（方案 B）**，还是坚持**真·单文件手写（方案 A）**？
2. **`session-query-sqlite` 的 patch**：接受**常驻 + 在面板里写清楚**（推荐），还是想要「能关」（那就得拆第二个小 bundle）？
3. **`plugin-zh`**：MVP 里保留现状（DOM 改法），还是**趁机改成官方 locale 注入**（更干净，但要先验证能不能注入别人的描述）？
4. **老仓库**：全部**归档保留**（推荐），还是有哪个要继续独立发版？

你回完这 4 条，我按阶段 0 开工。**在此之前我不动任何文件。**
