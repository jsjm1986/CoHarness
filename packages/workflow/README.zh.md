# workflow/：动态工作流能力家族

[English](README.md) | 中文

本家族通过 subagent 运行由模型编写的编排工作流，并将通用工具与固定策略工具公开给模型。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`workflow/`](workflow/README.zh.md) | 定义工作流执行和生命周期事件 | `ctx.workflowEngine` |
| [`workflow-ptc/`](workflow-ptc/README.zh.md) | 在线程中运行工作流脚本 | 注册到 `ctx.workflowEngine` |
| [`tool-workflow/`](tool-workflow/README.zh.md) | 向模型公开通用工作流执行 | 注册到 `ctx.tools` |
| [`tool-ralph/`](tool-ralph/README.zh.md) | 公开使用全新 agent（智能体）的固定 Ralph 工作流 | 注册到 `ctx.tools` |

worker thread 将工作流执行与宿主事件循环隔离，但不构成安全边界。参见[动态工作流](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.zh.md)和 [Ralph 工具](../../.agents/notes/implemented/feature/2026-07-19-fresh-agent-ralph-workflow-tool.zh.md)决策。

子系统参考——启动请求、`WorkflowMeta`、结果、实时运行、`workflow/*` 事件——见 [docs/subsystems/workflow.md](../../docs/subsystems/workflow.zh.md)；决策见[动态工作流](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.zh.md)与 [Ralph 消费方](../../.agents/notes/implemented/feature/2026-07-19-fresh-agent-ralph-workflow-tool.zh.md) Agent Note。


## 概述

workflow 组让 agent（智能体）可以运行编排脚本，将工作委派给 subagent 并返回最终值。`workflow` 工具支持脚本化扇出；需显式启用的 `ralph` 工具运行固定的全新 agent 序列。脚本使用共享 PTC Node 进程运行时，遵守调用 Session 的文件策略。工作流钩子和子 agent 生命周期仍由工作流引擎负责。
