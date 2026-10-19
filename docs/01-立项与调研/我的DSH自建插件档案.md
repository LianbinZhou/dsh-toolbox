# 我的 DSH 自建插件档案

> 整理日期：2026-10-17
> 范围：`C:\Users\zhou0\DeepSeek_Harness_Projects\dsh-plugins\` 下 **6 个**自建 DSH 插件
> 用途：为「要不要合并成一个私人定制大插件」这件事提供事实底稿
> 数据来源：各仓库的 `package.json` / `README.md` / 文件清单 / git 状态，以及 web profile 的实际安装记录

---

## 一、总览

| 插件 | 版本 | 一句话 | 界面？ | GitHub | 安装方式 | 代码行数 |
|---|---|---|---|---|---|---|
| `dsh-archive-manager` | 0.2.1 | 侧栏「历史归档」面板：列归档会话、一键恢复、二次确认删除 | 有 | ✅ LianbinZhou/dsh-archive-manager | **`file:` 拷贝** | 3184 |
| `dsh-quote-reply` | 0.1.0 | 划选对话文字 → 浮出「引用 / 复制」→ 引用插进输入框 | 有 | ✅ LianbinZhou/dsh-quote-reply | `link:` | 1015 |
| `dsh-draft-saver` | 0.1.0 | 草稿保险箱：没发送的内容全浏览器共享一份，新建会话也不丢 | 有 | ✅ LianbinZhou/dsh-draft-saver | `link:` | 971 |
| `dsh-panel-menu` | 0.1.0 | 把侧栏那排面板入口收进一个「全部面板」弹出菜单，把高度还给会话列表 | 有 | ✅ LianbinZhou/dsh-panel-menu | `link:` | 719 |
| `dsh-plugin-zh` | 0.1.0 | 插件管理页的英文简介换成中文（28 条词条） | 有 | ❌ 没推 | `link:` | 623 |
| `dsh-session-search` | 1.0.0 | 给 AI 装「回忆」：`session_search` 工具，能翻全部历史会话 | **无（纯宿主）** | ✅ LianbinZhou/dsh-session-search | `link:` | 464 |

**合计约 6976 行**，6 个独立 git 仓库，5 个已在 GitHub，全部工作区干净、与远程同步。

---

## 二、逐个档案

### 1. `dsh-archive-manager` —— 历史归档面板

| 项 | 内容 |
|---|---|
| 治什么病 | DSH 原生只能在侧栏归档会话，归档后就**没有入口找回来**，也没法物理删除 |
| 做什么 | 侧栏加「历史归档」入口；面板列出所有归档会话（真实标题 + 归档时间）；每条有「恢复」和「删除（二次确认）」；面板打开自动刷新 + 每 3 秒轮询 |
| 界面还是幕后 | 界面（侧栏 + 面板） |
| 客户端依赖注入 | `dsh-client-runtime` / `dsh-client-connection` / `dsh-client-ui-workspace`（**3 个，是 6 个里最多的**） |
| 代码结构 | ⚠️ **唯一有构建步骤的**：`src/`（源码）→ `build.mjs` / `build-client.mjs` → `lib/`（产物，**已提交进仓库**） |
| 测试 | ⚠️ **没有 `test/` 目录**，但仓库根目录堆了 8 个临时脚本：`_precheck.mjs`、`activate.mjs`、`delete-service-test.mjs`、`delete-test.mjs`、`host-test.mjs`、`loader-test.mjs`、`stub-loader.mjs`、`title-test.mjs`，还有个 `_delete_test.txt`。**没有 `npm test`** |
| 安装 | ⚠️ **`file:./node_modules/dsh-archive-manager`** —— 装进去的是**拷贝**，不是链接。改仓库源码**不会**影响正在跑的 DSH，要手动再拷一次 |
| 特别说明 | 这是你**第一个开源项目**，有纪念意义。功能上已被 `@linxin666/dsh-session-archive` 覆盖，但**不建议删** |

### 2. `dsh-quote-reply` —— 划词引用

| 项 | 内容 |
|---|---|
| 治什么病 | 想对 AI 回答里的某一句追问时，只能自己复制、粘贴，或者「你说的第二段那个…」绕半天 |
| 做什么 | 划选任意对话文字（你的、AI 的、代码块、工具输出都行）→ 上方浮出 `↩ 引用` / `⧉ 复制` → 引用以 Markdown 引用块插到**光标位置** |
| 界面还是幕后 | 界面（两个插槽：`shell.overlay` 负责浮层，`conversation.input.overlay` 负责写进输入框） |
| 客户端依赖注入 | `dsh-client-ui-conversation` |
| 代码结构 | 单文件 `client.js`（22 KB，6 个里最大） |
| 测试 | ✅ `test/sink.test.mjs`（7 KB），`npm test` 可跑 |
| 安装 | `link:`（改完刷新页面即生效） |
| 备注 | 交互抄的通义千问那套「划词浮条」 |

### 3. `dsh-draft-saver` —— 草稿保险箱

| 项 | 内容 |
|---|---|
| 治什么病 | 输入框打了字没发，切去别的会话再回来字没了。根因：草稿按会话 ID 存，而「新会话」每次新建、空白会话又不进侧栏 → 入口被藏起来了 |
| 做什么 | 全浏览器只留**一份**草稿：任何输入/删减都镜像到全局备份，任何会话打开时把最新那份交回去。**清空也同步** |
| 实现手法 | patch `Storage.prototype` 的 `getItem`/`setItem`，走 DSH 自己的恢复路径（不碰编辑器，输入法/`@文件` 胶囊行为不变） |
| 界面还是幕后 | 界面（输入框上方的提示条 `[复制][清空][知道了]`） |
| 客户端依赖注入 | `dsh-client-ui-conversation` |
| 测试 | ✅ `test/draft.test.mjs`（13 KB，**40 项**，假 localStorage 驱动真实 `client.js`），`npm test` 可跑 |
| 安装 | `link:`（**改 `client.js` 后要 Ctrl+F5 硬刷新**） |
| 踩过的坑 | ① DSH 会把已有草稿原样写回一遍，不识别「重放」就会用旧内容覆盖新备份；② 会话插槽拿不到 sessionId，提示条只能靠草稿文本判断 |

### 4. `dsh-panel-menu` —— 侧栏面板收进弹出菜单

| 项 | 内容 |
|---|---|
| 治什么病 | 侧栏上方那排面板入口（插件/自动化任务/技能中心/记忆系统/历史归档）占掉约 210px，把会话列表挤扁 |
| 做什么 | 整排收进一个「全部面板」弹出菜单，放在侧栏底部，位置还给工作区与会话列表 |
| 界面还是幕后 | 界面（侧栏） |
| 客户端依赖注入 | `dsh-client-ui-sidebar` |
| 代码结构 | `client.js` 22 KB + `icon.svg` |
| 测试 | ❌ 无 |
| 安装 | `link:` |
| 备注 | 纯**个人审美偏好**型插件，别人未必想要 |

### 5. `dsh-plugin-zh` —— 插件说明中文化

| 项 | 内容 |
|---|---|
| 治什么病 | 插件管理页把 `description` 原样显示；第三方插件普遍没有 `locale/` 目录，全是英文 |
| 做什么 | 翻译**页面已渲染的文本**（不动插件包）。28 条词条，覆盖页面上所有插件 + 官方实验性插件 |
| 实现手法 | MutationObserver + 文本节点空白归一化后精确匹配；前 40 字符唯一命中可容忍尾部截断；只改 `nodeValue`；跳过 `code/pre/textarea/input`；界面语言非中文时自动不工作 |
| 界面还是幕后 | 界面（无依赖注入，`inject: []`） |
| 测试 | ✅ `test/dict.test.mjs`（9 项） |
| 安装 | `link:`，**昨天刚装的** |
| 未完成 | ⚠️ **没推 GitHub**（本地仓库已建，无远程地址） |
| 扩展方式 | F12 里 `[...__DSH_PLUGIN_ZH__.unknown]` 导出未翻译的英文，加进词典 |

### 6. `dsh-session-search` —— 给 AI 装回忆

| 项 | 内容 |
|---|---|
| 治什么病 | 模型默认只看得到当前会话。你说「我们上次聊过那个」，它只能猜或让你重说 |
| 做什么 | 注册 `session_search` 工具，三种模式：搜索 / 读取某会话 / 浏览最新。底层走 SQLite FTS5 持久索引（`~/.dsh/storages/session-search.db`） |
| 界面还是幕后 | **纯宿主**，没有任何界面 |
| 客户端依赖注入 | 无（`dsh.client` 字段不存在） |
| 代码结构 | 单文件 `index.js`（11.8 KB） |
| 测试 | ❌ 无 |
| 安装 | `link:` |
| ⚠️ **特殊之处** | ① 包名是 **`@local/dsh-session-search`**（不是标准 npm 名，不能直接发布）；② 它带 **`overrides: ["session-query-sqlite"]`** —— **顶替了官方的一行**；③ 官方有个同名工具的实验 bundle，**两者不能同时开**（工具名重复会让 DSH 直接抛错） |

---

## 三、现状里的 5 个「不一致」

这些是合并时必须先想清楚的事，不是毛病，是现实：

| # | 不一致 | 影响 |
|---|---|---|
| 1 | **安装方式两套**：archive-manager 是 `file:`（拷贝），其余 5 个是 `link:`（链接） | 前者改源码要手动再拷一次，后者改完刷新就行。同一个人的东西，两套手感 |
| 2 | **构建方式两套**：只有 archive-manager 有 `src/`→`lib/` 构建 | 合并后要么全都搞构建，要么把它改回单文件 |
| 3 | **测试覆盖不均**：3 个有 `test/`（draft-saver 40 项、quote-reply、plugin-zh），archive-manager 测试脚本堆在根目录，panel-menu 和 session-search 没有 | 合并后「一次改全崩」的风险主要在这两个没测试的身上 |
| 4 | **包名不统一**：5 个是 `dsh-xxx`，1 个是 `@local/dsh-session-search` | 要发布就得改名 |
| 5 | **GitHub 状态**：5 个已推、同步；`dsh-plugin-zh` 没推 | 合并后新仓库的「首发」范围怎么定 |

---

## 四、按「能不能独立给别人用」自己先分个类

> 这一步是给你理思路用的。同一类的东西适合放在一起。

| 类别 | 插件 | 特点 |
|---|---|---|
| **通用工具**（别人也用得上） | `dsh-plugin-zh`、`dsh-draft-saver`、`dsh-quote-reply`、`dsh-session-search` | 治的是 DSH 本身的毛病，跟你的使用习惯无关。这类适合**保持独立、能单独发布** |
| **个人审美** | `dsh-panel-menu` | 你觉得侧栏挤，别人未必。纯口味 |
| **有纪念意义 + 已被覆盖** | `dsh-archive-manager` | 第一个开源项目；功能上被 `@linxin666/dsh-session-archive` 覆盖了 |

---

## 五、如果真要合并，会碰到的 4 道具体关卡

这些是**技术上绕不过去的事实**，不是我的意见：

**① 一个包只能有一个浏览器半边**

DSH 读 `dsh.client` 是**按包**读的（校验函数 `parseDshClient(pkgName, value)` 拿包名当诊断前缀），你机器上这 6 个包也全是单入口。

而 5 个带界面的插件，依赖注入各不相同：

```
archive-manager → dsh-client-runtime + dsh-client-connection + dsh-client-ui-workspace
panel-menu      → dsh-client-ui-sidebar
draft-saver     → dsh-client-ui-conversation
quote-reply     → dsh-client-ui-conversation
plugin-zh       → （空）
```

合进一个包 = 注入取并集、加载时机取一个 = **5 个界面模块一起加载、一起挂**。

**② `session-search` 的 override 特权会挂在整个大包上**

它 `overrides: ["session-query-sqlite"]`。合并后，只要大包开着，官方那行就永远被顶掉，无法单独关掉这个行为。

**③ 行级的 `cordis.patch.yml` 能插多行，但客户端半边不行**

一个包的 patch 插 6 行是**可以**的（官方 `dsh-base` 就是这么干的，它的行指向不同子路径）。所以「宿主侧合并」没有障碍 —— **卡住的只有客户端那半边**。

**④ archive-manager 的构建与安装方式要重新定**

它现在是「改源码 → 跑 build → 拷进 node_modules」。并进任何统一结构，都得先决定：继续保留构建，还是改成和其它一样的单文件直出。

---

## 六、代码规模参考

| 插件 | 宿主代码 | 客户端代码 | 测试代码 |
|---|---|---|---|
| archive-manager | `lib/index.js` 18.5 KB + `lib/paths.js` 6.3 KB | `lib/client.js` 17.5 KB | 根目录 8 个 .mjs，约 36 KB |
| quote-reply | `index.js` 0.4 KB（空壳） | `client.js` 22.4 KB | 7.2 KB |
| draft-saver | `index.js` 0.4 KB（空壳） | `client.js` 18.7 KB | 13.5 KB |
| panel-menu | `index.js` 0.35 KB（空壳） | `client.js` 21.7 KB | — |
| plugin-zh | `index.js` 0.4 KB（空壳） | `client.js` 16.8 KB | 2.8 KB |
| session-search | `index.js` 11.8 KB | — | — |

> 规律很明显：**5 个里 4 个是「客户端插件」**（宿主半边只是空壳，为了让 bundle 能挂一行），唯一有实质宿主逻辑的是 `session-search`。

---

## 七、留给你想的几个问题

1. 你说的「统一管理」，最想解决的是**插件页太乱**，还是**改代码要开好几个仓库**？
2. `dsh-plugin-zh` / `dsh-draft-saver` / `dsh-quote-reply` 这几个通用的，要不要留着单独发布给别人用？
3. `dsh-archive-manager` 要不要保持原样（作为第一个项目的纪念），不并进任何新结构？
4. 你愿不愿意为了「插件页只剩一行」接受**一起生一起死**（改一行全重启、一个 bug 全崩、没法单独开关）？
5. 老 GitHub 仓：留着当归档，还是把历史搬进新仓（`git subtree`）？
