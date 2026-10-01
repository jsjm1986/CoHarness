---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jobs

[English](README.md) | 中文

Web 后台任务特性的归属方：向 `conversation.session.header.actions` 贡献一个条目，列出当前会话可见的 `ctx.jobs` 记录。名册数据来自 [`dsh-client-runtime`](../runtime/README.zh.md) 从 `session/jobs` 帧折叠出的 `jobsBySession` 列表镜像，本包因此不另存名册。行交互走 sessions 服务：展开可观察行会启动一个引用计数的 `ctx.sessions.observeJob` 循环，把宿主的 `jobs.output` 读取轮询进运行时的 `observedJobs` 快照；停止控件则经 `ctx.sessions.killJob` 调 `jobs.kill`。

只有当会话至少有一个任务时才渲染触发器，普通对话不会因为一项未被使用的能力而长出控件。角标计数为 `running` 加 `stopping`，为零时省略，这样只剩已完成任务的会话保留一个安静的历史入口，而不是宣告一个「零」。弹层是一个扁平列表：活跃行在前按 `startedAt` 升序，随后终态行按 `finishedAt` 降序；毫秒相同的并列按启动顺序打破，宿主的 map 迭代顺序永远不参与决定。一行显示生产者 kind、label、状态标记、生产者一旦给出 `detail` 就取代通用状态词的那段文字，以及已耗时。该耗时在活跃时每秒推进，并在 `finishedAt` 冻结；只有当打开的列表里确实有会动的东西时时钟才运行。缺少 `finishedAt` 的终态行读作零而不是负数，超过一小时的耗时停留在小时单位，不会长出任何生产者目前都到不了的「天」词汇。

终态行保持可见并弱化，直到注册表在 owner 销毁时把它们丢掉。它们本就在快照里，失败任务的 `detail` 是其失败唯一可读之处，在这里过滤掉它们是输出与中断两期要推翻的工作。因此一个运行中的一次性后台 subagent 会同时出现在这里和 [subagent 目录](../ui-subagent/README.zh.md)里：目录负责进入子会话的 transcript，而这个列表持有停止控件。

活跃行、以及环内仍留有输出（`output.total` 大于零）的终态行，可以展开成一个由观察循环供给的终端面板。面板复制的是命令而非输出，命令与输出行都完整换行，输出在固定高度内滚动而非折叠，且不另画运行状态点——状态由上方行承载。保留缺口、有损读取与读取失败以面板上方提示呈现；尾部有界，超出环容量的任务显示缺口标记而非丢失的头部。最后一个展开查看者释放时，轮询停止并丢弃已累积文本。运行中行还带一个两段式停止控件：第一次按下武装它，三秒内的确认按下发出 kill，行随后经下一帧 `session/jobs` 收敛（`stopping`，再进入终态分区，其 `detail` 携带宿主转发的 `cancelled by the user` 原因）。kill 不占用生产者的终态投递，属主 agent 仍会收到常规的完成通知。存在活跃任务时终态分区折叠在其计数之后，可在客户端清空；没有保留输出的终态行保持静态，包括答案已发给模型的 subagent。

Escape 关闭列表并把焦点交还触发器，在其外部按下指针同理。768px 以下同一列表会变为遵守安全区的手机 Sheet，复用共享遮罩并把行提升到触控尺寸。最后一个任务消失时先关闭列表再卸载控件，焦点因此不会从一个被移除的节点上凭空消失。样式只用 token；文案走本包自己的 `job` locale 命名空间。行为由 [Web 后台任务展示 Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.zh.md) 规定。

## 概述

本包渲染 Web GUI 的后台任务界面：一个会话头部动作，打开后以弹层列出本会话可见的任务。它经运行时的 `jobsBySession` 镜像读取名册状态；行交互（输出观察、kill）经 `ctx.sessions` 落在宿主的 `jobs.output`/`jobs.kill` 方法上。触发器只在会话至少有一个任务时出现，角标计数运行中与停止中的任务；终态行保持可见并弱化，直到注册表把它们丢弃。模型对同一批任务的视角属于 `dsh-tool-jobs`。

## 目录

- [不变量](#invariants)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="invariants"></a>
## 不变量

**运行时不变量：** 未发布配套入口。Job 记录完全经由运行时的 `jobsBySession` 与 `observedJobs` 镜像到达；本包自身不发起 RPC，只持有弹层可见性。


<a id="model-experience"></a>
## 模型体验

无，因为本包为人类渲染宿主计算出的注册表状态，不触及提示词、消息、schema、流或工具结果。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **观察到的只是渲染尾部** —— 面板累积的是任务保留环的有界尾部；首次读取前已被环驱逐的字节、或被渲染界裁掉的字节，以缺口提示呈现而非可恢复的历史。进程重启会让循环中途终止，行回到它的名册状态。
- **列表不等于注册表自己的集合** —— 它展示的是「一个会话通过线路视图能看到什么」，所以别的会话拥有的任务在这里永远不出现；而进程重启会清空列表，transcript 里启动这些任务的 `run_in_background` 卡片却还在。无主任务（在没有活体 `Agent` 时启动的）是反过来的情形：它会进入每一个会话的列表，与 `list(caller)` 对每个调用方的报告一致。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
