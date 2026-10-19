S4-b 第一步：红灯 → 3 条，全是要命的
矩阵用真实临时目录跑（不是 mock）：建真的 sessions/<project>/session-xxx/、真的 Windows 目录联接（junction）指向根外的目录、真的投影缓存文件。

红灯（迁移来的原样代码）
用例	结果	实际后果
S1 根目录自身不可删	❌	removeSessionDir(sessions, sessions) 不抛错 → 整个 sessions 树被递归删除
S2 穿越 id 不可越界	❌	scrubProjcache(base, ['../../outside/marker']) 真的删掉了 home 外的文件
S3 恶意字符 id	❌	x\0y 控制字符放行（`* ? : " < >
S1 的根因很典型：isInside 把"等于根"也算进"在里面"——这个概念对"包含性判断"是对的，但对"能不能删"是灾难。

绿灯（旧代码本来就对的，留作回归）
S1b 上溯目录拒绝 · S4/S4b junction 逃逸（发现阶段不返回、删除前拒绝、目标文件存活）· S5 ../ 解析不到东西 · S6 越界拒绝/不存在就抛 · S7 正常删除 · S8 id 规范化。

修法
js


// ① 根目录单独判，且现在先算 rootReal 再比
if (real === rootReal) throw new Error("refusing to remove the sessions root itself")

// ② 缓存键先过 safeCacheKey：不合格的 id 不产生任何键
const keysBy = (id) => { const safe = safeCacheKey(id); return safe === null ? [] : [safe, safe.replace(/^session-/, '')] }

// ③ isSafeSessionId 收紧：控制字符、Windows 保留字符、尾部点/空格一律拒
结果
代码块


paths 安全矩阵  10 / 10 全绿
全量测试       122 / 122 全绿
提交 b1fc1ad。

一个必须告诉你的发现（跟你已开源的仓库有关）
这三条不是"迁移引入的"，它们原样存在于 LianbinZhou/dsh-archive-manager 已发布的代码里。

S1：那个函数目前只在 delete() 里被 findSessionDir 的返回值调用，正常路径碰不到根目录，所以线上没炸。但它是导出的、且是"防御性代码"，一旦哪天有人直接传路径进去，就是全盘删除。
S2：scrubProjcache 的调用方先过了 isSafeSessionId，所以也没炸。但一个会 unlink 的文件操作不信任自己的参数，是等着出事。
S3：影响最小，只是把"畸形 id"放进了文件系统走查（走到的是 readdir 匹配，匹配不到就返回 undefined）。
要不要我把这三处修同时回补到开源仓库（打个小版本 0.2.2）？这是已发布代码里的真实安全缺陷，公开项目里被别人读到会有人提 issue。你说要不要，我不擅自改那个仓库的历史。

下一步（按你的指令）
宿主服务的安全挂载（ctx.inject）：

主 inject 保持 ['tools']
归档用 ctx.inject(['webServer','storageDomain','workspaceRegistry','sessionPersistence','sessionQuery'], cb) 可选挂载
缺任何一个 → 只关归档功能，工具箱其余部分照常活着
挂载失败要能被 listConfigs 看见（不是静默消失）
我这就去做，下一条给你："缺服务时工具箱仍然可用"的测试证据。