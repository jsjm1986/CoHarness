# jobs/：后台任务能力家族

[English](README.md) | 中文

本家族为长时间运行的工具提供一套按所有者隔离的后台任务协议，用于观察、取消、等待和完成通知。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`jobs/`](jobs/README.zh.md) | 定义任务注册表和生命周期约定 | `ctx.jobs` |
| [`jobs-local/`](jobs-local/README.zh.md) | 实现进程本地任务注册表 | 注册到 `ctx.jobs` |
| [`tool-jobs/`](tool-jobs/README.zh.md) | 向模型公开任务控制和完成通知 | 注册到 `ctx.tools` |

参见[后台任务运行时](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.zh.md)和[任务注册表](../../.agents/notes/implemented/architecture/2026-07-26-job-registry-seam.zh.md)决策。

子系统参考文档——id 方案、所有者隔离约定、快照——见 [docs/subsystems/jobs.md](../../docs/subsystems/jobs.zh.md)；设计见[后台任务运行时](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.zh.md)与[任务注册表约定](../../.agents/notes/implemented/architecture/2026-07-26-job-registry-seam.zh.md)两篇 Agent Note。


## 概述

jobs 组是后台工作能力家族：运行长时间工作的工具把工作注册为任务，拥有它的 agent（智能体）可以在不阻塞自身轮次的情况下读取、等待、列出或取消任务。任务属于启动它的 agent 会话，因此一个 agent 永远不会看到另一个 agent 的工作；任务完成时以会话内通知送达给拥有它的 agent，无需轮询。本组拆分为注册表约定（`jobs`）、其进程本地存储（`jobs-local`）以及带完成通知的模型侧控制工具（`tool-jobs`）。
