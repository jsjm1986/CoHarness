---
description: "English | 中文"
kind: "package-reference"
---

# `@deepseek-ai/dsh-client-ui-reference`

[English](README.md) | 中文

统一的 Web `@file` 与 `@session` source。每个候选请求都会持有发起浏览的 Client Session 直至完成，并等待其初始历史打开后，才启动 `fileReferences/list` 和 `sessionReferenceResolver/candidates` Remote 调用；对于未加引号的 token，两个调用随后同时发出。未被持有的会话会让查询失败而不是重新打开它；任一候选领域的失败都会独立降级。各行以确定性顺序先列文件、再列出浏览会话的直接 subagent、最后列普通会话，并渲染在不可选择的分组标题下，不显示重复的原始 `reference` source 标题。行内只保留区分信息：文件仅在其父目录未被下钻列表的面包屑表达时标出该目录，会话仅在其工作区不是当前工作区时标出该工作区。会话行携带会话列表的相对活跃时间；列表中不存在的会话回退到候选项的创建时间。尚未闭合的 `@"…` token 只搜索文件。

选择文件会把共享 `@path` 语法所定义的自然文本保留为隐藏的序列化与剪贴板形式。文件会关闭补全，并显示为文件图标加业务色文件名、无胶囊容器的原子行内引用。目录在普通 pick 时落定为原子文件夹引用；显式下钻（Tab、行尾箭头或面包屑）则把 token 替换为可编辑路径文本，并让菜单在尾部斜杠处保持活跃。下钻后的目录列表会发布可返回的工作区面包屑。包含空白的路径使用 `@"path with spaces"`，用户显式打开的引号会继续保留。

选择会话会插入一个原子的行内引用，其隐藏 `ref` 与剪贴板表示均为宿主返回的规范 `@[label](dsh-session:…)` mention。可见形式为聊天气泡图标加业务色会话标题，不使用胶囊容器；序列化永远不会根据该标题重建身份。普通发送会通过 `session.prompt` 携带规范 mention，session-reference 服务会在 `agent/pre-step` 校验它并捕获模型上下文。

`/client` 只导出插件主体（`apply`／`inject`）；候选编码保留在注册 effect 内部。

## 概述

Web 用户需要从同一个 `@` 补全菜单提及文件、文件夹或会话时，可以使用 `dsh-client-ui-reference`。每个请求都会持有浏览会话直至其初始历史打开，而不是重新打开已释放的会话。菜单依次列出文件、该会话的直接 subagent、普通会话；其中一组无法加载时，另一组仍然可用。行内只保留区分信息——父目录、非当前工作区、相对活跃时间。pick 会插入带稳定剪贴板形式的原子引用；文件夹行还允许用户在不关闭补全的情况下继续下钻。会话 mention 会在捕获模型上下文前接受校验；浏览不影响模型。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

间接影响模型体验：通过宿主拥有的提供方实现，本包的引用选择把文件指引与会话快照准备委托给它们。

#### KV Cache 影响

浏览候选项不会影响模型。选择文件或会话只会改变新用户消息的后缀，以及紧随该消息、由宿主准备的会话引用上下文；目标会话更早的历史保持不变。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **候选失败有意保持静默**：Remote 发现调用不可用或失败时，该领域不产生候选行。会话引用准备失败发生在提示词接受后，并会终止该 agent 轮次。
- **浏览器侧不扫描文件**：Web 补全需要挂载宿主 `ctx.fileReferences` 提供方；浏览器无法回退到自身文件系统。
- **会话搜索仍仅使用元数据**：发现流程通过 `ctx.sessionReferenceResolver` 筛选 session id、cwd 和以日志为依据的最新标题；不搜索消息主体或完整 transcript（文本记录）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
