# 安装指南（INSTALL）

> 这份文档假设你**没怎么用过命令行**。每一步都写了「在哪敲」和「敲完应该看到什么」。
> 如果你连终端是什么都不想了解，直接看第 0 节。

---

## 0. 给 AI 的一句话安装法（最省事，推荐先试这个）

**如果你不想敲任何命令**：把下面整个方框里的内容复制，粘贴到你电脑上 DSH 的对话框里，发送。让 AI 帮你装。

```text
请帮我从 GitHub 安装插件 dsh-toolbox，仓库地址：
https://github.com/LianbinZhou/dsh-toolbox

请按顺序执行，每一步做完告诉我结果：

1. 先判断我的 DSH 是 Web 版还是桌面版（看地址端口：3080 = Web 版）。
   如果是桌面版：**命令行装不了**（官方独占管理），请停下告诉我这一点，不要硬跑命令。
   如果用户坚持要装，告诉他「桌面版有一条手动路径，但不是官方支持，见 8.2 节」，让他自己决定。

2. 执行安装（只适用于 Web 版）：
   dsh plugin --profile web add github:LianbinZhou/dsh-toolbox

   ⚠️ 绝对不要执行 `add dsh-toolbox` —— npm 上有一个同名的、
   完全无关的包（别人的「股票盯盘 + 小说阅读器」插件），会装错。
   必须带 `github:LianbinZhou/dsh-toolbox` 这个前缀。

3. 装完后检查并告诉我这两件事：
   - 命令输出的最后是不是 `Done in ...s using pnpm`
   - 打开 C:\Users\<我的用户名>\.dsh\profiles\web\package.json，
     看 dsh.profile.bundles 里有没有出现 "dsh-toolbox"

4. 告诉我怎么重启 DSH、重启后去哪里找到这个插件、怎么打开它的设置开关。

5. 最后把卸载命令也给我，我要留着备用。

6. 如果我的机器连不上 github.com，告诉我怎么开代理，别反复重试。
```

### 发出去之后，你可能会看到这些

| 你看到的 | 意思 | 你要做什么 |
|---|---|---|
| 弹出一个「是否允许执行命令」的确认框 | 正常的权限确认 | 点「**允许 / 批准**」 |
| AI 说它没有权限执行命令 | 会话权限不够 | 把会话权限切到「**完全权限（Full Access）**」，再发一次 |
| AI 说 `profile "desktop" is managed exclusively by the Electron application` | 你用的是桌面版，命令行装不了 | 桌面版请找应用内的插件管理页操作，或改用第 3 节手动步骤 |

> ⚠️ **一句话安装法的前提**：你的 DSH 必须能执行终端命令。
> 如果它一直拒绝，别耗时间，退回第 3 节手动装，一样能装好。

---

## 1. 三十秒版（会一点点终端的人看这个）

```sh
# 安装
dsh plugin --profile web add github:LianbinZhou/dsh-toolbox

# 然后重启 DSH，去「插件管理」找到 dsh-toolbox，打开设置卡片里的开关

# 卸载（留着备用）
dsh plugin --profile web remove dsh-toolbox
```

---

## 2. 装之前先确认前置条件

| 需要什么 | 具体要求 | 怎么确认 |
|---|---|---|
| **DSH 本体** | 已经能正常打开并对话 | 能打开就算过 |
| **Node.js** | **20 或更高**（推荐 22 LTS） | 终端敲 `node -v`，看到 `v20.x` / `v22.x` / `v24.x` 就行 |
| **pnpm** | DSH 自带，一般不用管 | 装 DSH 时已经有了 |
| **网络** | 能访问 github.com | 浏览器打开 https://github.com 试试 |

### 关于 Node 版本（这条最容易卡住人）

- `esbuild` 要求 Node ≥ 18
- `playwright`（只有源码编译才用到）要求 Node **≥ 20**
- 所以本指南统一按 **Node 20+** 写

看版本：终端敲 `node -v`。如果显示 `v18.x` 或更低，去 https://nodejs.org 下 LTS 版重装。

### 关于 profile：先搞清楚你是哪个版本（很重要）

| 你的 DSH | 地址栏端口 | 能不能用本文的命令 |
|---|---|---|
| **Web 版**（桌面「Web版DeepSeek-Harness」） | `127.0.0.1:3080` | ✅ 能 |
| **桌面版**（桌面「桌面版DeepSeek Harness」） | 随机端口（如 19387） | ❌ 命令行不行（会报错）；✅ 手动改文件可以（见 8.2） |

桌面版的 profile 由应用独占管理，`dsh plugin --profile desktop ...` 会直接拒绝。
**但这不等于"桌面版装不了"**——本机已用「改 profile 文件 + 建软链」的方式在桌面版装成并正常使用（2026-10-11 起），
细节和回滚方法在 **8.2 节**。那条路**非官方支持**，桌面版升级前请先备份。

---

## 3. 安装方式 A：一键安装（推荐）

三个平台的**命令完全一样**（`dsh` 是跨平台的）。不同的只是「怎么打开终端」：

| 系统 | 怎么打开终端 |
|---|---|
| **Windows（PowerShell）** | 按 `Win` 键 → 输入 `powershell` → 回车 |
| **Windows（Git Bash）** | 在任意文件夹空白处右键 →「Git Bash Here」 |
| **Linux** | `Ctrl + Alt + T` |
| **macOS** | `Command + 空格` → 输入 `terminal` → 回车 |

打开终端后，把这行**原样复制**进去，回车：

```sh
dsh plugin --profile web add github:LianbinZhou/dsh-toolbox
```

### 你应该看到什么（真实输出）

```
dependencies:
+ dsh-toolbox github:LianbinZhou/dsh-toolbox

Packages: +1
+
Progress: resolved 1, reused 0, downloaded 1, added 1, done
Done in 8.4s using pnpm v11.21.0
```

看到 `Done in ...s` 就是成功了。

### ⚠️ 为什么不能写 `add dsh-toolbox`

因为 **npm 上确实有一个同名的 `dsh-toolbox` 包**，是另一位作者（ldchao）做的完全不同东西——侧栏股票盯盘 + 本地 txt 小说阅读器。

敲 `add dsh-toolbox` 会装上**那个**，不是本文这个。

判断方法：装完去插件列表看，如果出现了「🧰 工具箱 / 股票盯盘 / 看小说」，装错了，按第 5 节卸掉重来。

### 这一步做了什么（想搞懂原理再看）

1. 从 GitHub 拉取仓库（不是从 npm）
2. 在 `~/.dsh/profiles/web/` 里登记依赖
3. **自动**把 `dsh-toolbox` 写进 `package.json` 的 `dsh.profile.bundles`（不用你手改）
4. 仓库里已经带了构建好的 `client.js`，**所以这一步不需要编译**

---

## 4. 安装方式 B：源码编译安装（想改代码 / 想锁版本）

适合：你想看源码、想改点东西、或者想固定到某个 commit。

### 4.1 下载源码

```sh
git clone https://github.com/LianbinZhou/dsh-toolbox.git
cd dsh-toolbox
```

Windows PowerShell 里也一样能用 `cd` 进目录。

### 4.2 装依赖

```sh
npm install
```

实测约 **17 秒**（8 个包）。中途可能看到这条警告，**是正常的，不影响**：

```
npm warn install-scripts 1 package has install scripts not yet covered by allowScripts:
npm warn install-scripts   esbuild@0.28.2 (postinstall: node install.js)
```

### 4.3 构建

```sh
npm run build
```

实测约 **60 毫秒 ~ 半秒**（取决于机器），输出：

```
> dsh-toolbox@0.7.4 build
> node tools/build.mjs

  client.js  130.6kb

⚡ Done in 60ms
```

### 4.4 注册到 DSH

```sh
dsh plugin --profile web add link:<你刚才进的那个目录的完整路径>
```

**Windows 示例**（注意路径用正斜杠 `/`，反斜杠容易出错）：

```sh
dsh plugin --profile web add link:C:/Users/你的用户名/dsh-toolbox
```

**Linux / macOS 示例**：

```sh
dsh plugin --profile web add link:/home/你的用户名/dsh-toolbox
```

看到 `Done in ...s` 即成功，`bundles` 同样会自动写入。

### 为什么仓库里已经有构建产物？

因为作者把 `client.js` 一起提交了。所以：
- 走「方式 A」的人**不需要编译**，也不需要 Node 之外的工具链
- 走「方式 B」的人自己编出来的结果，和仓库里那份**逐字节完全一致**（SHA256 都是 `3D96C21A9C2B28B1FBAF2002ED6F0AB01416A20A2B18CF2A89759A0964F89799`）

---

## 5. 验证装成功了

### 5.1 先重启 DSH（必做）

装完之后，**正在运行的 DSH 不会自动加载新插件**。必须重启：

- **Web 版**：桌面「关闭DSH」→ 等窗口关掉 → 再双击「Web版DeepSeek-Harness」
- **桌面版**：完全退出应用（不是最小化）再打开

> ⚠️ **重启完还要浏览器硬刷新一次：`Ctrl + Shift + R`（Windows/Linux）或 `Command + Shift + R`（macOS）。两件都要做。**
>
> 只重启不刷新、或只刷新不重启，都可能撞上这条「假故障」：
>
> ```text
> 历史加载失败：typert gateway: session/follow:
> active Service "sessionController" is unavailable（gateway/service-unavailable）
> ```
>
> **这不是插件坏了，也不是你装错了。** 装插件会让 profile 的 `cordis.patch.yml` 变化，
> DSH 在**热重组**那零点几秒里，`sessionController` 服务会短暂下线；页面正好这时候请求就报这个。
> 按上面的「重启 + 硬刷新」再来一遍即可恢复。
>
> **实测记录（Linux，2026-10-23）**：装完立刻出现此报错，重启 + 硬刷新后消失，
> 随后 `session_search` 工具立刻返回真实结果，证明搜索链路正常。

### 5.2 看插件列表里有没有这一行

打开 DSH → 左侧栏「**插件管理**」（或设置里的 Plugins 页）→ 找到一行 **dsh-toolbox**。

### 5.3 打开它的设置开关

点这一行进入详情，里面是一张**设置卡片**（不是自动生成的表单，是本插件自己画的），有 7 个开关：

| 开关 | 默认 | 作用 |
|---|---|---|
| 会话搜索 `sessionSearch` | ✅ 开 | 给 AI 用的 `session_search` 工具 |
| 划词引用 `quoteReply` | ✅ 开 | 选中文字弹出「引用 / 复制」 |
| 草稿保险箱 `draftSaver` | ✅ 开 | 输入框内容全局备份 |
| 面板收纳 `panelMenu` | ✅ 开 | 侧栏面板入口收进一个菜单 |
| 历史归档 `archivePanel` | ✅ 开 | 侧栏「历史归档」面板 + 回收箱 |
| 归档 HTTP 接口 `archiveHttpApi` | ❌ **关** | 本机 7 条令牌保护的接口，不用就别开 |
| 插件说明汉化 `pluginZh` | ✅ 开 | 插件页英文简介换中文 |

开关是**实时生效**的，拨一下不用重启。但改完界面没变的话，按 `Ctrl + F5` 硬刷新一次。

### 5.4 用命令行确认（进阶，可选）

打开这个文件看 `bundles` 里有没有 `dsh-toolbox`：

- Windows：`C:\Users\<你的用户名>\.dsh\profiles\web\package.json`
- Linux / macOS：`~/.dsh/profiles/web/package.json`

---

## 6. 卸载（留好后路）

一条命令：

```sh
dsh plugin --profile web remove dsh-toolbox
```

实测 **1 秒**完成。它会：
- 从 `node_modules` 移除插件
- **自动**把 `dsh-toolbox` 从 `bundles` 列表里删掉（不留残渣）

然后**重启 DSH**，插件就从列表里消失了。

### 卸载不会删你的数据

| 数据 | 卸载后 |
|---|---|
| 归档的会话 | 还在 `~/.dsh` 里 |
| 回收箱里的会话 | 还在（保留期照常倒计时） |
| 草稿备份 | 还在浏览器的 localStorage 里（`dsh-draft-saver.backup.v1`） |
| 全文搜索索引 | 还在 `~/.dsh/storages/` 里 |

**只有插件本身被移除**，你的会话和草稿一条都不会少。

### 如果你是「方式 B（`link:` 本地源码）」装的

`dsh plugin remove` 会清掉 `package.json` 的依赖和 `bundles` 列表，但有一处**它不删**：

**`node_modules` 里的符号链接不会自动删除**（从 npm 装的会删，`link:` 的不会）。

手动补一刀即可（只删链接，**不会动你的源码目录**）：

```sh
# Linux / macOS
rm ~/.dsh/profiles/web/node_modules/dsh-toolbox
```

```powershell
# Windows PowerShell
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-toolbox"
```

> **实测记录（Linux，2026-10-23）**：卸载另外两个 `link:` 型旧包时踩到——
> `package.json` 和 `bundles` 都清干净了，但 `node_modules` 里的软链还在。

### 想确认彻底干净

再跑一次安装命令，如果它报「已经是依赖」之类，说明没删干净；正常情况是它重新装一遍。或者直接看 `package.json` 的 `bundles` 里没有 `dsh-toolbox` 即可。

---

## 7. 常见问题（FAQ）

### Q1：装完重启，插件列表里还是没有 dsh-toolbox

按顺序排查：

1. **真的重启了吗？** 关窗口不算，要看到进程退出（Web 版用桌面「关闭DSH」）
2. **profile 对了吗？** 你装的是 `--profile web`，但你打开的是桌面版？
3. **bundles 写进去了吗？** 看 `~/.dsh/profiles/web/package.json` 里 `dsh.profile.bundles` 有没有 `dsh-toolbox`
4. **装到别的 profile 了？** 重新跑一遍安装命令，看输出里的 profile 名字

### Q2：报错 `profile "desktop" is managed exclusively by the Electron application`

你在桌面版上用了命令行。桌面版的 profile 被应用独占，命令行改不了。请用应用内的插件管理页。

### Q3：命令找不到：`dsh : 无法将"dsh"项识别为 cmdlet...`

DSH 的 `dsh` 命令不在 PATH 里。说明 DSH 可能没装好，或者装的是桌面版（桌面版自带运行时，不提供 `dsh` 命令）。

### Q4：装成了「股票盯盘 / 看小说」

你用了 `add dsh-toolbox`（少了 `github:` 前缀），装到了 npm 上别人的同名包。**先卸掉再重装**：

```sh
dsh plugin --profile web remove dsh-toolbox
dsh plugin --profile web add github:LianbinZhou/dsh-toolbox
```

### Q5：`npm install` 报错，说什么 Node 版本不支持

Node 太旧。敲 `node -v` 看，低于 v20 就去 https://nodejs.org 装 LTS。

### Q6：连不上 GitHub（国内网络常见）

这台机器有代理的话，让 git 也走代理：

```sh
git config --global http.proxy socks5h://127.0.0.1:10808
```

（把 `10808` 换成你自己的代理端口。没开代理就跳过这条。）

装完之后想取消代理：

```sh
git config --global --unset http.proxy
```

**更省事的办法**：直接用第 0 节的一句话安装法，让 DSH 帮你处理网络问题。

### Q7：插件页有这一行，但开关拨了没反应

浏览器端的部分要**硬刷新**才生效：按 `Ctrl + F5`（macOS 是 `Command + Shift + R`）。

### Q8：怎么判断我装的是 Web 版还是桌面版？

看浏览器地址栏：`127.0.0.1:3080` = Web 版；其他端口（比如 19387）= 桌面版。

### Q9：我装完发现自己根本不需要它，怎么彻底清理？

按第 6 节卸载，然后重启。不需要手动删任何文件夹——`remove` 会把依赖和 bundles 一起清掉。

---

## 8. ⚠️ 已知限制（安装前必读）

**这一节不是劝退，是让你装之前心里有数。**

### 8.1 会话搜索用内存索引（v0.7.4 起）

**历史问题（v0.7.1 及更早）**：`cordis.patch.yml` 里把全文搜索索引的路径**硬编码**成了作者自己电脑上的绝对路径：

```yaml
path: 'C:\Users\zhou0\.dsh\storages\session-search.db'
```

这个路径在别人的机器上不存在，装上之后**会话搜索会静默失效**（其余 6 个功能不受影响）。

**v0.7.4 起已修复**（修复本身在 v0.7.3 就进了代码，v0.7.4 是包版本号与 tag 对齐后的发布版）：改成 `:memory:`（内存索引）。

- ✅ 不写任何磁盘路径，不指向任何人的目录，**谁装都能用**
- ✅ 不往你的磁盘里多塞一个数据库文件
- ⚠️ **代价**：索引不跨重启保存。每次重启 DSH 后的**第一次**搜索要重建一次索引，会话多的话可能要等几秒；搜过一次之后就恢复正常速度

> 如果你希望索引持久化（重启后不用重建），可以在自己的
> `~/.dsh/profiles/web/cordis.patch.yml` 里覆盖这一条，用 `!!js` 表达式算路径，
> 不要写死绝对路径。这是可选项，默认的 `:memory:` 已经够用。

### 8.2 桌面版：命令行不行，但手动可以（**非官方路径**）

**结论先说**：`dsh plugin --profile desktop add ...` **会被官方拒绝**（见第 2 节）。
但要在桌面版里用 toolbox，**手动改 profile 文件是可行的**——本机 2026-10-11 实测装成，持续使用至今。

> ⚠️ **这是非官方路径**。桌面版 profile 由 Electron 应用独占管理，以后升级可能覆盖或改动内部结构。
> **装之前务必先备份**，装完留好回滚文件。

#### 装（先把桌面版完全关掉）

**第 1 步：备份两个文件**

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$p\package.json"    "$p\package.json.bak-before-toolbox"
Copy-Item "$p\pnpm-lock.yaml"  "$p\pnpm-lock.yaml.bak-before-toolbox"
```

**第 2 步：改 `package.json`**

在 `dependencies` 里加一行，在 `dsh.profile.bundles` 数组末尾加一项：

```json
{
  "dependencies": {
    "dsh-toolbox": "link:C:/你的路径/dsh-plugins/dsh-toolbox"
  },
  "dsh": {
    "profile": {
      "bundles": ["已有的...", "dsh-toolbox"]
    }
  }
}
```

**第 3 步：建符号链接**（Windows 需要管理员权限或开启开发者模式）

```powershell
New-Item -ItemType SymbolicLink `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-toolbox" `
  -Target "C:\你的路径\dsh-plugins\dsh-toolbox"
```

**第 4 步：装依赖**

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm install
```

**第 5 步：启动桌面版**，看插件列表里有没有 `dsh-toolbox` 那一行。

#### 卸载（同样手动）

1. 从 `package.json` 的 `dependencies` 和 `bundles` 里删掉 `dsh-toolbox`
2. **手动删软链**（`dsh plugin remove` 不会管这个）：

```powershell
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-toolbox"
```

3. 回到 profile 目录跑一次 `pnpm install`

#### 出问题怎么回滚

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$p\package.json.bak-before-toolbox"   "$p\package.json"   -Force
Copy-Item "$p\pnpm-lock.yaml.bak-before-toolbox" "$p\pnpm-lock.yaml" -Force
Remove-Item "$p\node_modules\dsh-toolbox" -ErrorAction SilentlyContinue
cd $p; pnpm install
```

#### 实测记录（Windows 桌面版）

| 日期 | 操作 | 结果 |
|---|---|---|
| 2026-10-11 | 手动改 `package.json` + 建软链 + `pnpm install` | ✅ 装成，插件生效，正常使用 |
| 2026-10-20 | 卸载两个旧的 `link:` 包，换装 toolbox | ✅ 成功；软链需手动删 |
| 2026-10-21 | 用同样方式升级 7 个第三方插件 | ✅ 成功；`pnpm install --frozen-lockfile` 通过 |

### 8.3 本文档的实测范围

| 平台 | 状态 |
|---|---|
| **Windows** | ✅ 全流程实机验证（见第 9 节） |
| **Linux（Mint 22.3 Xfce / Ubuntu noble 基底）** | ✅ **已实机验证通过**（2026-10-23，见第 9 节） |
| **Windows 桌面版（Electron 应用）** | ✅ **手动安装已实测**（2026-10-11，见 8.2）；命令行被官方拒绝 |
| **macOS** | ⚠️ 尚未实机验证 |

Linux 和 Windows 用的是**完全相同的命令**，唯一的差异是：中国大陆网络下，
必须先给命令设 HTTP 代理才能访问 github.com（详见第 7 节 Q6）。

---

## 9. 实测记录（本文所有命令都真跑过）

**环境**：Windows 11 · Node `v24.21.0` · pnpm `11.21.0` · DSH（npm 全局包）· 测试日期 2026-10-20

| # | 执行的命令 | 退出码 | 耗时 | 结果 |
|---|---|---|---|---|
| 1 | `git ls-remote https://github.com/LianbinZhou/dsh-toolbox.git` | 0 | — | 返回 `d79af83…`，仓库可达 |
| 2 | `dsh plugin --profile <临时> add github:LianbinZhou/dsh-toolbox` | **0** | 8.4s | 安装成功；`bundles` 自动写入 `dsh-toolbox` |
| 3 | 检查安装产物 | — | — | `client.js`（133,735 字节）已随包带上，无需构建 |
| 4 | `dsh plugin --profile <临时> remove dsh-toolbox` | **0** | 1s | 移除成功；`bundles` 自动删掉该行 |
| 5 | `git clone …` | 0 | — | 完整仓库 |
| 6 | `npm install` | **0** | 17s | 8 个包（含 esbuild 告警，不影响） |
| 7 | `npm run build` | **0** | 430ms | 产出 `client.js` 130.6kb |
| 8 | 对比构建产物 SHA256 | — | — | 与仓库提交版本**完全一致** |
| 9 | `dsh plugin --profile <临时> add link:<本地路径>` | **0** | 1.7s | 本地源码安装成功，`bundles` 自动写入 |

> 测试用的临时 profile 在每轮测试后**已删除**，没有动过你的 `web` profile。

### Linux 实机实测（2026-10-23 补充）

**环境**：Linux Mint 22.3 Xfce（Ubuntu `noble` 基底）· 内核 `6.14.0-37` · Node `v22.23.3` ·
pnpm `10.34.7` · DSH `@deepseek-ai/dsh@0.2.1-rc.2`（本地安装，非 npx）· 中国大陆 + HTTP 代理

| # | 执行的命令 / 检查 | 退出码 | 耗时 | 结果 |
|---|---|---|---|---|
| L1 | `dsh plugin --profile web add github:LianbinZhou/dsh-toolbox` | **0** | **5.9s** | 一次成功；`bundles` 自动写入 `dsh-toolbox` |
| L2 | 检查安装产物 | — | — | `client.js` **133,735 字节**，与 Windows 实测**逐字节一致** |
| L3 | `node --check client.js` / `index.js` | 0 | — | 语法正常 |
| L4 | `dsh --profile web --dump-config`（独立进程，不碰运行实例） | **0** | — | 1576 行、**0 报错**；`session-query-sqlite` 正确改成 `:memory:` + `first-search` |
| L5 | 启动日志 | — | — | `session_search installed` / `archive services ready` / 7 条路由已挂，**0 错误** |
| L6 | 实调 `session_search` 工具 | — | — | 立刻返回真实结果（会话搜索链路通） |
| L7 | `curl /api/archive-manager/token` | — | — | **200**（归档 HTTP 接口已挂） |
| L8 | `dsh plugin --profile web remove dsh-toolbox` | **0** | 1.2–1.4s | 移除成功；`bundles` 自动删掉该行 |

**耗时对比**：Linux 5.9s / Windows 8.4s，同一量级；安装产物完全相同。

**Linux 上额外确认的一点**：宿主服务是**按依赖顺序晚到**的，启动日志会先出现

```text
[dsh-toolbox] 宿主服务不可用: webServer（不存在）—— 相关子功能已禁用
[dsh-toolbox] 宿主服务不可用: workspaceRegistry（不存在）—— 相关子功能已禁用
```

随后自动变成为

```text
[dsh-toolbox] webServer became available; syncing the archive routes
[dsh-toolbox] archive adapter probe: workspaceRegistry=object, sessions=object | 自检 missing=[] degraded=[]
```

这是**防腐层在正常工作**（先降级、后自愈），不是故障，看到 `missing=[] degraded=[]` 就说明全部到位。

### 未实测的部分（老实交代）

| 项目 | 状态 | 原因 |
|---|---|---|
| ~~Linux（Ubuntu / Debian 等）~~ | ✅ **已实测（2026-10-23）** | 见上方「Linux 实机实测」 |
| macOS | ⚠️ 未实测 | 无环境 |
| ~~桌面版 profile 安装~~ | ✅ **已手动实测（2026-10-11）** | 命令行被拒；改用「改 profile 文件 + 建软链」，见 8.2。**非官方路径，升级前先备份** |
| 「插件列表出现一行 + 打开开关」 | ⚠️ 未逐步截图 | 属于 GUI 操作，请按第 5 节自查 |

如果你在 macOS 上跑这份指南卡住了，**不是你的问题**——把卡住的那一步和报错原文告诉我，我改文档。
