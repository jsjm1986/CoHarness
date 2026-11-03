---
description: "共享项目动态：右侧栏展示成员发送的消息与选择的回答"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-project-activity

[English](README.md) | 中文

项目动态插件的浏览器半：一个右侧栏标签类型（`activity`），回答「这个项目最近发生了什么」。默认档位渲染面向人的**进展纪要**——Gateway 对共享可见成员活动做的 AI 梳理，经 `GET /account/api/progress` 读取——顶部是滚动覆写的「当前进展」摘要，下方按周折叠的期次条目分「定了 / 完成 / 进行中 / 卡点」四节，每条署名回成员与会话；状态条报告水位后未梳理的活动数，并提供手动 `POST /account/api/progress/generate` 入口，面板轮询等待其落地。三种原始阅读视图保留在相邻档位：`时间` 把 `GET /account/api/activity` 条目按日折叠，`会话` 把每个会话折成摘要块、块头摘要行优先呈现最新回答，`成员` 把每人折成速写块、摘要行先列「定了」再列「说了」。Feed 按 keyset 游标倒序分页并提供成员筛选；行与纪要署名通过 `conversationViewport.reveal(sessionId, seq)` 打开对应会话——无锚点的行走 `replaceActive`——让成员直接落到那条日志事件上。

标签类型跟随当前会话所属的 Runtime；未限定 Runtime 的独立会话使用页面项目策略。apply 体订阅会话选择与策略变化，Guide 入口因此只向项目会话显示，在个人会话中隐藏。每个正文只捕获一次所属身份：Feed 分页、纪要读取、手动生成及会话链接始终保留完整 Runtime UUID，即使另一浏览器标签修改空间 cookie 也不会改变。Gateway 对每次请求重新检查当前访问权限。视图状态仍按会话保存。进展路由返回 `400`/`404` 时显示功能未启用页。Host 半保持惰性，插件只经 Client 加载器挂载。

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

分组使用会话与成员 ID，标题和显示名不参与身份判定。改名仍保留同一组，不同 ID 始终分开。Feed 读取被替代后，即使完成解码也不能覆盖较新的页面。

日期分组和会话近期时间使用查看者的本地日历。昨天指前一个日历日期，夏令时切换改变实际经过时长时也遵循这一规则。

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
