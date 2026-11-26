---
description: "使用并排查实验性 Web Agent Teams 模式开关、roster、共享任务板与 teammate 导航面板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

[English](README.md) | 中文

## 概述

本包向 Web 会话页头添加 Agent Teams action，让用户为根 Session 启停 Team 模式、检查当前 roster 与共享任务板并导航到 teammate 会话。Team 状态来自客户端 `agentTeam` Session 投影与 addressed-subagent 成员目录；唯一的 Remote 调用是 `agentTeams/setEnabled`，用于翻转持久根 Session 选择。通过公开发布的实验性 Agent Teams Web profile 选择本包。这个浏览器 projection 不扩展稳定 API Proxy、不存储 Team 状态，也不注册面向模型的输入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.zh.md) 启用本包。这个组合包同时提供团队服务、工具与 Web 界面。Web Client loader 挂载 `/client` export；root Host export 不执行行为，本包也没有用户配置字段。

### 检查并导航 roster

Panel 通过 `useProjection('agentTeam')` 渲染模式与任务，成员行来自直接 child 目录：持久 name 与运行时 activity,Lead 固定为首行。选择 teammate 会打开普通的 `{ parentSessionId, childSessionId, mode: 'continuable' }` address。History 与后续人类提示词继续使用稳定 addressed-subagent 会话路径；本包不会添加 Team 专用 address 字段。该 action 只在根 Session 上渲染——被寻址或已列出的 child 会话返回 null。

### 启停 Team 模式

触发器的模式控件对当前根 Session 调用 `agentTeams.setEnabled`。对已不带 Team 模式运行过的会话启用、以及对仍有存活 teammate 的会话停用，都会请求确认，因为每次翻转都是一条比点击更长命的持久 `team/mode` 记录。Remote 失败在面板内呈现而不是关闭面板。

### 查看任务板

任务板展示 task identity、owner、blocker、readiness、提示性 write scope 与重叠 warning。它是只读的；agent 通过 Team 工具修改任务，panel 渲染修改后的 view。

窄屏下，成员名单与任务板使用单列。长任务名称换行，面板在可见视口内滚动，关闭操作保持可访问。分组标题的数字徽标居中显示，并与标签保持间距。不透明面板阻止背景会话文字透入阅读区域；空间不足时，模式确认说明和操作在模式标签下方换行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client export 挂载来自 [`@deepseek-ai/dsh-experimental-agent-team/remote`](../agent-team/README.zh.md) 的生成的 `ctx.remote.agentTeams` contribution，然后通过 Cordis effect 注册 locale dictionary 与一个 conversation-header slot。Dispose plugin fiber 会移除这两项 registration。

切换 session 会关闭 panel 并丢弃为上一个 session 发出的在途模式变更；投影与目录无需面板级 refresh 就能让其他行保持最新。

panel 通过 portal 渲染，由 `useAnchoredPosition` 锚定到触发器右缘并在任意视口尺寸下钳制在视口内。悬停经短延迟打开并保留触发器到面板的跨越宽限，点击会钉住 panel；外部指针、Escape 或工具栏关闭按钮都会将其关闭。钉住时 panel 获得焦点，Escape 把焦点还给触发器。当页头容器把触发器文案折叠为纯图标时，仅点击可打开。选择 roster 成员会导航到该会话；当前成员会被标记且不可点击。

| 文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 生成的 Remote、locale、导航与 slot registration |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Roster 与任务板渲染状态 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文 panel 文案 |
| [`src/index.ts`](src/index.ts) | 不执行行为的 Host entry |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent Teams bundle](../agent-team-profile/README.zh.md)——挂载本 Client plugin 的公开 opt-in bundle。
- [Agent Teams service](../agent-team/README.zh.md)——权威 roster、task 与 Remote 行为。
- [会话 UI](../../client/ui-conversation/README.zh.md)——稳定 header slot 与 addressed-subagent 导航表层。
- [实验性包](../README.zh.md)——孵化状态与发布规则。

-----


<a id="model-experience"></a>
## 模型体验

无直接影响，因为该浏览器 projection 不注册面向模型的输入。

#### KV Cache 影响

无直接影响；Team 工具与普通会话提交负责后续任何模型可见用途。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **普通 child continuation**——导航后发送的人类消息使用稳定 addressed-subagent 提示词路径；panel 不添加 Team 专用消息面。
- **没有 lifecycle 或 workspace control**——panel 不能 spawn、rename、delete 或 interrupt teammate，也不能编辑任务，write scope 仍只是提示性 metadata。
- **仅根 Session 的 action**——触发器在被寻址或已列出的 child Session 上隐藏；不存在 teammate 侧视图。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
