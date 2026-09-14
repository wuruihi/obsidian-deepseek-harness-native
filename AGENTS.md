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
- **折叠管线（v0.3.0 起）**：事件 → `DshFold`（`FOLD-PURE` 标记块：交错 segments / chunkrow 正文恢复 / 嵌套 callId / 步骤卡 / 跨回合回溯），改折叠必跑 `node scripts/fold-regress.mjs`（当前 34 用例）。
- **DSH 0.1.5 事件形状（v0.7.2 实测，改折叠/渲染前必读）**：
  - 助手正文是 `assistant/message.data.message.content = [{type:"text"|"reasoning"|"tool-call",text}]`（**数组**，旧版为整段字符串），且该轮不再有 `assistant/chunk` 流式帧 → 只认字符串三处（DshFold / `foldLatestTurn` / 实时分派）都会丢掉整条回复、面板只剩空气泡。统一走 `foldAssistantParts`。
  - 事件次序是 `turn/start → user/message(kind=user) → 注入帧 → assistant/message → turn/end`：人类消息落在 `turn/start` **之后**。折叠管线**不得**再用 `user` 项当回合边界（`_openTurn` 只认未结束的 turn）；`user/message` 项要**插到当前回合之前**，否则 DOM 里回复排到用户气泡上面。
  - 0.1.5 的 `user/message.data.text` 是 `undefined`，文本在 `content[]`；注入帧（plugin/agent-instructions/skill-catalog）靠 `stripSystemContext` 剥空、不落 items。
  - 正文既要写 `turn.text` **也要进 `turn.segments`**：渲染层有 segments 时只按段渲染，只写 text 等于「有正文但不显示」。
- **用户提问应答（v0.7.1 起）**：`ask_user_question` 答案编码在 `QUESTION-PURE` 标记块（`questionAnswer`），契约是 `{answers:[{id, selected:string[], custom?}]}`——selected 必须是数组、id 回显，改这里必跑 `node scripts/question-regress.mjs`（当前 13 用例）。四个回归全绿才算改完。
- **真机形状验证脚本**（`D:\02-bywork\tmp-plugin-debug\`，抓包用、非交付物）：`live.mjs`（新会话发一条→实时流+快照两条路径跑插件 fold，验证正文还原）、`shape.mjs`（快照事件形状 + fold 结果）、`order.mjs <sid>`（任意会话事件次序）、`scan-shapes.mjs`（全库会话正文存储形态统计）。
- 对齐基准是 `D:\repos\dsh-vscode`（webview/src 是视觉与行为规格的权威）；同步其 CHANGELOG 时先比对现状，只补真缺口。

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
