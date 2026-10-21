---
description: "共享项目动态：右侧栏展示成员发送的消息与选择的回答"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-project-activity

[English](README.md) | 中文

项目动态插件的浏览器半：一个右侧栏标签类型（`activity`），回答「这个项目最近发生了什么」。默认档位渲染面向人的**进展纪要**——Gateway 对共享可见成员活动做的 AI 梳理，经 `GET /account/api/progress` 读取——顶部是滚动覆写的「当前进展」摘要，下方按周折叠的期次条目分「定了 / 完成 / 进行中 / 卡点」四节，每条署名回成员与会话；状态条报告水位后未梳理的活动数，并提供手动 `POST /account/api/progress/generate` 入口，面板轮询等待其落地。三种原始阅读视图保留在相邻档位：`时间` 把 `GET /account/api/activity` 条目按日折叠，`会话` 把每个会话折成摘要块、块头摘要行优先呈现最新回答，`成员` 把每人折成速写块、摘要行先列「定了」再列「说了」。Feed 按 keyset 游标倒序分页并提供成员筛选；行与纪要署名通过 `conversationViewport.reveal(sessionId, seq)` 打开对应会话——无锚点的行走 `replaceActive`——让成员直接落到那条日志事件上。

标签类型只在 `projectUiPolicy` 报告项目空间时注册：apply 体订阅策略快照，每次切换都挂载或释放 `sidebarRightTabs` 定义，Guide 胶囊与已打开的标签随空间一同来去。带 key 的 `sidebar.right.pane.tab` 正文与 `sidebar.right.pane.tab.title` 座常驻挂载——没有存活的类型时它们不派发任何内容。视图状态（分页、档位、成员筛选、纪要页面）保存在正文注册声明的会话级 store 中；inject 面携带 `refresh`、`loadMore(before)`、`generate` 与经 `ctx` viewport 服务的 `reveal`。进展路由返回 `400`/`404` 时渲染为「功能未启用」页而非传输失败，未挂载纪要服务的部署安静降级。Host 半是惰性的：插件只经 Client 加载器挂载。

`/client` 导出插件体（`apply`/`inject`）、Feed 线路类型、store 工厂与状态类型、注入面类型。

## 概述

Web GUI 的项目动态标签现在默认展示 AI 书写的项目进展纪要——滚动摘要加按周折叠的期次、署名到成员与会话——原始 Feed 在相邻档位，可按时间、会话或成员分组，支持成员筛选，并能链接到确切的会话事件。它只在共享项目空间出现，读取既有 Gateway 路由——不创建新的数据流。

## 目录

- [不变量](#invariants)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="invariants"></a>
## 不变量

**运行时不变量：** 不发布伴随件。Feed 由 Gateway 路由从持久会话数据派生；插件只持有一个视图状态 store。

<a id="model-experience"></a>
## 模型体验

无，因为本包是成员消息与已选回答的浏览器端只读投影，不向模型请求添加任何内容。

#### KV Cache 影响

无——插件不执行任何模型可见操作。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **仅人类行**——Feed 只列成员消息与已选回答；自动任务、Webhook 回合、权限模式切换与审批执行日志按设计排除。审批行面向另一种阅读问题，继续延后。
- **纪要依赖 Postgres 部署与模型路由**——未挂载进展服务时（非 Postgres 部署、功能开关关闭、或无托管模型凭据），进展档位渲染「暂不可用」页；原始 Feed 仍可用。
- **无已读位置**——按成员的「上次看到这里」标记延后；没有未读态或通知面。
- **补链前的回答无锚点**——`call_id` 持久化（迁移 056）之前认领的回答不渲染提问原文，也不跳转到结果帧。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
