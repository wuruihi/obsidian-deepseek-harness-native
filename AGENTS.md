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
- **用户提问应答（v0.7.1 起）**：`ask_user_question` 答案编码在 `QUESTION-PURE` 标记块（`questionAnswer`），契约是 `{answers:[{id, selected:string[], custom?}]}`——selected 必须是数组、id 回显，改这里必跑 `node scripts/question-regress.mjs`（当前 13 用例）。**六个回归全绿才算改完**（fold / question / fence / auth / model / stats）。
- **真机验证脚本**（`D:\02-bywork\tmp-plugin-debug\`，抓包用、非交付物）：`verify-v073.mjs`（一次跑完：多步正文还原 + 会话真实模型 vs 全局默认 + token 口径；自建临时会话并自动删除）、`live.mjs`（新会话发一条→实时流+快照两条路径跑插件 fold）、`shape.mjs`（快照事件形状 + fold 结果）、`order.mjs <sid>`（任意会话事件次序）、`scan-shapes.mjs`（全库会话正文存储形态统计）、`model-probe{,2}.mjs`（模型契约探针：catalog/modelSelection/回执）。
- 对齐基准是 vscode 插件仓库 `D:\03-Projects\Plugins\dsh-vscode`（webview/src 是视觉与行为规格的权威；`CHANGELOG.md` 顶部是它最近的行为变更，同步前先比对现状，只补真缺口）。

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
