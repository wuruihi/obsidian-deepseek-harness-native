# DeepSeek Harness Native

在 Obsidian 侧边栏内驱动本地 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的原生面板插件。把 DSH 的智能体对话、代码执行、文档检索能力直接嵌入你的笔记工作流，并自动管理本地 DSH 服务。

> 本插件仅连接本机 `127.0.0.1` 上的 DSH 服务，不向任何第三方发送数据。

## 功能

- **侧边栏面板**：在 Obsidian 内打开 DSH 对话界面，无需切换浏览器。
- **双向桥接**：一键把当前笔记内容发送到 DSH，结果回写笔记工作区（vault）。
- **模型与权限**：底部状态栏切换模型（DeepSeek V4 Flash / Pro）与执行权限模式（queue / steer）。
- **服务自动管理**：可配置启动命令，打开面板时若本地 DSH 未运行则自动拉起；内置「一键安装」克隆并安装 DSH。
- **历史与会话**：新建 / 切换 / 历史会话，自动拉取并渲染 DSH 的流式回复（含思考链）。

## 前置条件

1. 安装并启用本插件。
2. 本地需要有 DSH 服务（由 [@deepseek-ai/dsh](https://github.com/deepseek-ai/deepseek-harness) 提供）。可在插件「设置 → DSH Native → 一键安装」自动克隆安装，或手动安装后用「启动命令」字段指定启动方式（必须以 vault 为 cwd 启动）。
3. DSH 默认监听 `127.0.0.1:3080`；可在设置中修改端口。

## 使用

- 命令面板执行 `打开面板` 打开侧边栏面板。
- 在输入框输入问题，回车发送；底部可切换模型与执行模式。
- 选中笔记内容后执行 `发送当前笔记到 DSH`，把笔记内容发给 DSH 处理。

## 设置

| 项目 | 说明 |
|---|---|
| 服务端口 | DSH Web 服务端口，默认 `3080` |
| 启动命令 | 启动 DSH 的命令，`{port}` 自动替换；需以 vault 为 cwd |
| 自动启动 | 打开面板时若端口无服务，自动运行启动命令 |
| Vault 路径 | DSH 工作区绑定的文件夹；留空用当前 vault 根 |
| 发送模式 | `queue`（追加排队）/ `steer`（打断插队） |

## 安装（手动）

1. 从 Releases 下载 `main.js`、`manifest.json`、`styles.css`。
2. 放入 `<vault>/.obsidian/plugins/deepseek-harness-native/`。
3. 在 Obsidian「设置 → 第三方插件」中启用。

## 许可证

[MIT](./LICENSE) © wupang
