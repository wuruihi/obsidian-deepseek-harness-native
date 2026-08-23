# DeepSeek Harness Native（DSH 原生面板）

一个 Obsidian 插件，让你**直接在笔记侧边栏里打开本地 DeepSeek Harness（DSH）面板**，不用切到浏览器。把 DSH 的智能体对话、代码执行、文档检索能力嵌进你的笔记工作流，并自动管理本地 DSH 服务。

> 隐私：本插件只连接你本机的 `127.0.0.1` 上的 DSH 服务，不向任何第三方发送数据。

## 它能做什么

- **侧边栏面板**：在 Obsidian 内打开 DSH 对话界面。
- **双向桥接**：一键把当前笔记内容发给 DSH，结果回写 vault。
- **模型与权限**：底部切换模型（DeepSeek V4 Flash / Pro）与执行权限（queue / steer）。
- **服务自动管理**：可配置启动命令，打开面板时若本地 DSH 未运行则自动拉起；内置「一键安装」克隆并安装 DSH。
- **历史与会话**：新建 / 切换 / 历史会话，自动渲染 DSH 流式回复（含思考链）。

---

## 安装方式一：手动放置（推荐，最简单）

适合从网盘/聊天记录拿到压缩包的用户。

1. **下载** 压缩包 `deepseek-harness-native-x.x.x.zip` 并解压，会得到文件夹 `deepseek-harness-native/`。
2. **打开你的 vault 文件夹**（Obsidian 里：打开命令面板 → 输入 `打开 vault 所在文件夹` 并回车）。
3. 进入里面的 `.obsidian/plugins/` 目录（`.obsidian` 是隐藏文件夹，需显示隐藏文件）。
4. 把解压出来的 `deepseek-harness-native/` 整个文件夹**复制进去**，和已有的其他插件并列。
5. **重启 Obsidian**（或命令面板执行 `重新加载应用` / 开发者模式下点插件旁边的刷新按钮）。
6. 打开 **设置 → 第三方插件 → 已安装**，找到 `DeepSeek Harness Native`，点开关启用。
7. 首次启用会弹出 **「是否信任来自互联网的插件」** 提示，点 **「信任作者并启用」** 即可。

> 提示：目录名必须是 `deepseek-harness-native`（和 manifest 里的 id 一致），改名会导致 Obsidian 识别不了。

---

## 安装方式二：BRAT（可自动更新，可选）

适合愿意用 Beta 插件安装器、希望以后一键升级的用户。

1. 在 Obsidian 社区插件市场安装 **BRAT**。
2. 打开 BRAT 设置 → `Add a beta plugin`。

   ```
   https://github.com/wuruihi/obsidian-deepseek-harness-native
   ```
3. 启用插件（同样需要信任提示）。以后有新版本，在 BRAT 里点 `Check for updates` 即可升级。

---

## 前置条件

本插件是 DSH 的「界面」，本身不含 DSH 引擎。使用前你需要在本机装好 DSH：

- 最简单：装好插件后，打开 **设置 → DSH Native → 一键安装**，会自动克隆并安装 DSH。
- 或手动安装 DSH 后，在插件设置里的「启动命令」填写你的启动方式（插件会以 vault 为工作目录启动它）。
- DSH 默认监听 `127.0.0.1:3080`，端口可在插件设置里改。

---

## 基本使用

- 命令面板执行 `打开面板` 打开侧边栏面板。
- 在输入框输入问题，回车发送；底部可切换模型与执行模式。
- 选中笔记内容后执行 `发送当前笔记到 DSH`，把笔记发给 DSH 处理。

## 设置项

| 项目 | 说明 |
|---|---|
| 服务端口 | DSH Web 服务端口，默认 `3080` |
| 启动命令 | 启动 DSH 的命令，`{port}` 自动替换；需以 vault 为 cwd |
| 自动启动 | 打开面板时若端口无服务，自动运行启动命令 |
| Vault 路径 | DSH 工作区绑定的文件夹；留空用当前 vault 根 |
| 发送模式 | `queue`（追加排队）/ `steer`（打断插队） |

## 许可证

[MIT](./LICENSE) © wupang
