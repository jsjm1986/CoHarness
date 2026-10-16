---
description: "共享项目动态：右侧栏展示成员发送的消息与选择的回答"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-project-activity

[English](README.md) | 中文

项目动态插件的浏览器半：一个右侧栏标签类型（`activity`），列出共享项目成员发送了什么、选择了什么——带署名的 `user/message` 行与 `ask_user_question` 回答（提问原文加选中的选项）——通过同源凭据读取账户级 `GET /account/api/activity` 分页。Feed 按 keyset 游标倒序分页；面板用分段控件在时间（按日、再按会话）、按会话、按成员三种分组间切换，并提供成员筛选、刷新与加载更早。点击行通过 `conversationViewport.reveal(sessionId, seq)` 打开对应会话——无锚点的行走 `replaceActive`——让成员直接落到那条日志事件上。

标签类型只在 `projectUiPolicy` 报告项目空间时注册：apply 体订阅策略快照，每次切换都挂载或释放 `sidebarRightTabs` 定义，Guide 胶囊与已打开的标签随空间一同来去。带 key 的 `sidebar.right.pane.tab` 正文与 `sidebar.right.pane.tab.title` 座常驻挂载——没有存活的类型时它们不派发任何内容。视图状态（分页、分组、成员筛选）保存在正文注册声明的会话级 store 中；inject 面携带 `refresh`、`loadMore(before)` 与经 `ctx` viewport 服务的 `reveal`。Host 半是惰性的：插件只经 Client 加载器挂载。

`/client` 导出插件体（`apply`/`inject`）、Feed 线路类型、store 工厂与状态类型、注入面类型。

## 概述

Web GUI 新增一个项目动态标签，展示每位成员发送了什么、选择了哪些回答，可按时间、会话或成员分组，支持成员筛选，并能链接到确切的会话事件。它只在共享项目空间出现，读取既有 Gateway 路由——不创建新的数据流。

## 目录

- [不变量](#invariants)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="invariants"></a>
## 不变量

**运行时不变量：** 不发布伴随件。Feed 由 Gateway 路由从持久会话数据派生；插件只持有一个视图状态 store。

<a id="model-experience"></a>
## 模型体验

无，因为本包是成员消息与已选回答的浏览器端只读投影，不向模型请求添加任何内容。

#### KV Cache 影响

无——插件不执行任何模型可见操作。

## 已知限制与延后工作

- **仅人类行**——Feed 只列成员消息与已选回答；自动任务、Webhook 回合、权限模式切换与审批执行日志按设计排除。审批行面向另一种阅读问题，继续延后。
- **无已读位置**——按成员的「上次看到这里」标记延后；没有未读态或通知面。
- **补链前的回答无锚点**——`call_id` 持久化（迁移 056）之前认领的回答不渲染提问原文，也不跳转到结果帧。
