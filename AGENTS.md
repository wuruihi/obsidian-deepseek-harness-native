# obsidian-deepseek-harness-native — 仓库规范

> 本文件给 AI 开发会话看（DSH 原生读取 AGENTS.md）。改代码前先读这里。

## 架构约定

- **`main.js` 即源码**：无构建链，CommonJS 直接手写；改完 `node --check main.js` 必须通过。
- **样式在 `styles.css`**，插件元数据在 `manifest.json` + `versions.json`（每次发版两处版本号同步 +）。
- **部署 ≠ 发布**：
  - 本机调试部署 = 复制 `main.js` / `styles.css` / `manifest.json` / `versions.json` 到 `D:\02-bywork\.obsidian\plugins\deepseek-harness-native\`，然后在 Obsidian 里关开插件开关重载（复制后用哈希比对确认一致）。
  - 用户侧更新走 GitHub Release，见下节。
- **渲染管线**：助手文本 → `preprocessAssistantText`（剥注入块 + 结构化切分）→ Obsidian `MarkdownRenderer` → `postProcessDshUi` 替换 dsh-ui 卡片。围栏/JSON 容错纯函数集中在 `FENCE-PURE-BEGIN..END` 标记块内，改渲染必跑 `node scripts/fence-regress.mjs`（当前 15 用例）。
- **协议层（v0.2.0 起）**：双协议自动探测（legacy rc.x 点端点 ↔ v012 斜杠端点+`{args}` 信封+铸 cookie 鉴权）；v012 纯函数/类在 `AUTH-PURE` / `V012-PURE` 标记块内，改协议必跑 `node scripts/auth-regress.mjs`（真机 E2E，当前 6 用例）。
  - **args 必须与网关描述符「逐参数精确匹配」**（`dsh-api-gateway assertExactArguments`：多键/缺键/改名都拒，且只在运行期报 `gateway/arguments-invalid`）。这套契约随 DSH 版本漂移、纯函数回归盖不到 → 改协议 / 加端点必跑 `node scripts/args-audit.mjs`（离线，从**已装 DSH** 解析网关描述符当 ground truth）+ `node scripts/execute-regress.mjs`（真机：旧键必被拒 + 插件真实入口必通）。已在真机验过的漂移：`commands/execute` 的 `images` → `submittedAttachments`（0.1.5，v0.7.4 踩中——症状是**权限切换与所有斜杠命令全哑**，发消息却正常，因为有另一条 `session/prompt` 通道）、`subagents/list` 由 `{request}` 改平铺（本插件不调它，改用 `session/list` 过滤 `origin`）。
  - 新增端点若网关没有对应实现（本地实现 / 走流桥），必须登记进 `args-audit.mjs` 的 `EXCEPTIONS` 并写明理由，否则审计报红。
- **会话归属（workspace grouping，v0.7.4 起，回归 `node scripts/wsgroup-regress.mjs`，当前 10 用例）**：
  - `session/create` 只接受 `workspaceId` 或 `cwd` 之一，且**只有 `workspaceId` 会把会话 attach 进工作区**；只给 `cwd` 时服务器照建会话、但不登记分组 → DSH 本体显示「未分组」（DSH 自己的 GUI client 注释就把这种会话叫 Ungrouped）。VSCode 插件一直传 `workspaceId`，所以只有本插件踩过这个坑。
  - 其它实测：`workspace.list` **不是一元端点**（`POST /api/workspace/list` → 404），必须走 `workspace/follow` 流桥（插件里是 `V012Mux.workspacesOnce()`）；`workspace/create` 回执是 `{workspace:{...}, created}` 而**不是**裸 workspace；存量「未分组」会话**客户端救不回来**——workspace 控制器只有 create/rename/delete/insertBefore/insertSessionBefore/archiveSession、**没有 attach**，`insertSessionBefore` 只对已登记会话生效，`session.fork` 按「是否已是成员」反查（不看 cwd）。
  - 本回归是**真代码路径**端到端：把 `require("obsidian")` 换成桩件（只有 `requestUrl` 需要真实现）、用 `new Function` 求值**真 `main.js`** 并把模块内私有的 `DshApi` / `DshAuth` / `V012Mux` 导出来，再用插件自己的代码（真实鉴权链、`{args}` 信封、流桥）打真机。**以后改协议 / 归属优先照这个套路加断言，别只读代码确认。**
- **启动链路（v0.7.5 起，`scripts/startup-regress.mjs`，当前 13 用例，离线夹具）**：
  - **默认设置里禁止任何机器专属路径**。0.7.4 之前 `DEFAULT_SETTINGS.startupCommand` 写死了作者机器的绝对路径（含用户名，还进了公开仓库），换机后插件自启必然 `Cannot find module`，而唯一症状是「等待服务就绪超时（120s）」——与「启动慢」无法区分、指向不了任何原因（VSCode 插件 0.18.5 同款事故）。改完记得 `loadSettings` 也要能迁移：只改默认值救不了已经存进 `data.json` 的机器。
  - 「装没装 DSH」必须按**结构**判定：`<dir>/node_modules/@deepseek-ai/dsh/lib/bin.js` 存在即算装。本机 `~/dsh` 就是 npm 部署形态（无 `.git`、`package.json` 既无 `name` 也无 `scripts`、无 `pnpm-workspace.yaml`）——只按仓库特征猜会漏掉本机唯一的真实安装。候选顺序：PATH 上的 `dsh` → cwd → `~/dsh` → `~/deepseek-harness` → 平台常见路径。
  - 显式配置优先，但**失效的显式路径要被报出并绕过**（回退自动探测），探测失败的消息要列出已探测目录；不允许「静默等到超时」。
  - 自启进程用 VBS `WScript.Shell.Run(cmd, 0, …)` 拉起：0 = 隐藏窗口，子进程继承同一个**隐藏控制台**——所以不会重演 DSH 子进程每次新建可见控制台的「闪窗」问题（`windowsHide`/`CREATE_NO_WINDOW` 才会，见 VSCode 仓库 `memory/dsh-host-console-window.md`）。
- **折叠管线（v0.3.0 起）**：事件 → `DshFold`（`FOLD-PURE` 标记块：交错 segments / chunkrow 正文恢复 / 嵌套 callId / 步骤卡 / 跨回合回溯），改折叠必跑 `node scripts/fold-regress.mjs`（当前 38 用例）。
- **DSH 0.1.5 事件形状（v0.7.2/.3 实测，改折叠/渲染前必读）**：
  - 助手正文是 `assistant/message.data.message.content = [{type:"text"|"reasoning"|"tool-call",text}]`（**数组**，旧版为整段字符串），且该轮不再有 `assistant/chunk` 流式帧 → 只认字符串三处（DshFold / `foldLatestTurn` / 实时分派）都会丢掉整条回复、面板只剩空气泡。统一走 `foldAssistantParts`。
  - **一个回合可以有多个 step，每个 step 各一条 `assistant/message`**：必须逐块 `_appendSeg` 全收，并按 `turn:step` 给「流式 delta」与「完成消息」去重（`assistant/chunk.data = {turn,step,chunk}` 实测有这两个字段）。用「整轮第一个正文」当守卫会丢掉后续步骤的正文（v0.7.2 缺口；真机判别样本：step1「开始执行」+ step2「dsh-multistep-probe」）。
  - 事件次序是 `turn/start → user/message(kind=user) → 注入帧 → assistant/message → turn/end`：人类消息落在 `turn/start` **之后**。折叠管线**不得**再用 `user` 项当回合边界（`_openTurn` 只认未结束的 turn）；`user/message` 项要**插到当前回合之前**，否则 DOM 里回复排到用户气泡上面。
  - 0.1.5 的 `user/message.data.text` 是 `undefined`，文本在 `content[]`；注入帧（plugin/agent-instructions/skill-catalog）靠 `stripSystemContext` 剥空、不落 items。
  - 正文既要写 `turn.text` **也要进 `turn.segments`**：渲染层有 segments 时只按段渲染，只写 text 等于「有正文但不显示」。
- **模型显示（v0.7.3 起，`MODEL-PURE` 块，回归 `node scripts/model-regress.mjs`，当前 22 用例，对齐 VSCode v0.18.3）**：
  - `session/modelCatalog`（**不接受 sessionId**，实测传了报错）返回的 `default` 是**宿主全局默认模型**（新会话起步模型，全项目共享）——它是「未知时会话模型」的兜底显示值，**绝不能**当成某会话的模型、**绝不能**写进 `settings.modelMemory`。
  - 会话真实模型只在宿主 `modelSelection` 投影里（`{lastUsed, next}`，next 优先），另有 `selectModel` 回执 `{selected:{provider,model,reasoningEffort?}}` 是归一化值。三源：历史快照 `projections.values.modelSelection` / 实时 `session/projection`（key=`modelSelection`，控制流 baseline 会为所有会话重放）/ 回执。按 sessionId 存在 `_sessionModels`。
  - 实测后果：本工作区 43 个会话里 **16 个**的真实模型 ≠ 全局默认 → 旧实现显示错模型，且会把全局默认写进「本项目最近使用模型」（跨项目串味）；模型大小写自动纠正也可能把**别的模型** selectModel 到当前会话上。
- **底栏统计（v0.7.3 起，`STATS-PURE` 块，回归 `node scripts/stats-regress.mjs`，当前 11 用例，对齐 VSCode v0.18.1）**：输入=总输入（cacheRead+uncached）、缓存命中%=cacheRead/总输入、K/M 缩写、零值不显示（旧实现只显示 uncached，量级差 ~8 倍）。
- **用户提问应答（v0.7.1 起）**：`ask_user_question` 答案编码在 `QUESTION-PURE` 标记块（`questionAnswer`），契约是 `{answers:[{id, selected:string[], custom?}]}`——selected 必须是数组、id 回显，改这里必跑 `node scripts/question-regress.mjs`（当前 13 用例）。**九个回归全绿才算改完**（fold / question / fence / auth / model / stats / wsgroup / args-audit / execute-regress）；动启动链路另跑 `startup-regress`。
- **真机验证脚本**（`D:\02-bywork\tmp-plugin-debug\`，抓包用、非交付物）：`verify-v073.mjs`（一次跑完：多步正文还原 + 会话真实模型 vs 全局默认 + token 口径；自建临时会话并自动删除）、`live.mjs`（新会话发一条→实时流+快照两条路径跑插件 fold）、`shape.mjs`（快照事件形状 + fold 结果）、`order.mjs <sid>`（任意会话事件次序）、`scan-shapes.mjs`（全库会话正文存储形态统计）、`model-probe{,2}.mjs`（模型契约探针：catalog/modelSelection/回执）、`wsgroup.mjs`（服务器契约 A/B：cwd=未分组 / workspaceId=已分组）、`wsgroup-plugin-e2e.cjs` + `obsidian-stub.cjs`（真代码路径端到端；已固化为交付用的 `scripts/wsgroup-regress.mjs`）、`patch-wsgroup{,2}.mjs`（带「旧串恰好出现一次」断言的补丁脚本）。
- 对齐基准是 vscode 插件仓库 `D:\03-Projects\Plugins\dsh-vscode`（webview/src 是视觉与行为规格的权威；`CHANGELOG.md` 顶部是它最近的行为变更，同步前先比对现状，只补真缺口）。**当前对齐到 VSCode v0.18.5**：v0.7.5 补上了它的 `commands/execute` 参数改名、启动命令「显式优先 + 自动探测 + 陈旧值绕过」、以及 args 审计脚本这三项。

## 发版流程（每次改完顺手做，缺一不可）

Obsidian 的更新机制只认 GitHub Release——光 push 代码用户拉不到新版本。

1. `manifest.json` 与 `versions.json` 版本号 +1，提交
2. 部署到本机 bywork 插件目录并哈希校验（自测）
3. `git push`（main）
4. `git tag <版本号>`（裸版本号，无 v 前缀，如 `0.1.9`）+ `git push origin <版本号>`
5. 用 GitHub REST API 创建 Release（tag 与 manifest 版本号精确一致），上传三个附件：`main.js`、`manifest.json`、`styles.css`
   - 认证：`"url=https://github.com" | git credential fill` 取凭据管理器里的令牌（仅内存使用，不打印、不落盘）；本机无 gh CLI
   - 创建：`POST /repos/wuruihi/obsidian-deepseek-harness-native/releases`
   - 传附件：`POST uploads.github.com/.../releases/{id}/assets?name=<文件>`，Content-Type `application/octet-stream`
6. GET Release 核验：非 draft、非 prerelease、三附件齐全

## 红线

- push / 发 Release 需用户明确要求或已授权的流程（本文件即授权「改完顺手发版」）；force push、删 tag/release 必须先问。
- 令牌不进代码、不进日志。
