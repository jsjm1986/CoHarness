# subagent/：subagent 能力家族

[English](README.md) | 中文

本家族允许一个 agent（智能体）将工作委派给子 agent。多个具名提供方可在同一上下文中共存。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`subagent/`](subagent/README.zh.md) | 定义提供方注册、委派和继续执行 | `ctx.subagents` |
| [`subagent-inprocess/`](subagent-in-process-driver/README.zh.md) | 提供共享的进程内运行驱动器 | 无 |
| [`subagent-spawn-in-process/`](subagent-spawn-in-process/README.zh.md) | 启动全新的进程内子 agent | 注册到 `ctx.subagents` |
| [`subagent-fork-in-process/`](subagent-fork-in-process/README.zh.md) | 从父 agent 已完成的历史记录启动进程内子 agent | 注册到 `ctx.subagents` |
| [`subagent-acp/`](subagent-acp/README.zh.md) | 通过 ACP（Agent Client Protocol）启动进程外子 agent | 注册到 `ctx.subagents` |
| [`subagent-codex/`](subagent-codex/README.zh.md) | 启动真实的 Codex app-server 子 agent | 注册到 `ctx.subagents` |
| [`subagent-claude-code/`](subagent-claude-code/README.zh.md) | 通过官方 Claude Agent SDK 启动真实的 Claude Code 子 agent | 注册到 `ctx.subagents` |
| [`subagent-dsh-sdk/`](subagent-dsh-sdk/README.zh.md) | 通过 TypeScript SDK 启动进程外 Harness 子 agent | 注册到 `ctx.subagents` |
| [`tool-subagent/`](tool-subagent/README.zh.md) | 向模型公开委派操作 | 注册到 `ctx.tools` |
| [`tool-subagent-control/`](tool-subagent-control/README.zh.md) | 向模型公开相邻 Agent 消息、中断与列举操作 | 注册到 `ctx.tools` |

Codex 与 Claude Code 包是彼此独立的可选 Profile Bundle。使用 `dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-codex @deepseek-ai/dsh-subagent-claude-code` 安装其中一个或两个包，再重启该 Profile；每个包只注册自己的休眠 Host provider。要授予工具，请复制一份完整 Agent Preset，删除各对应工具行的 `disabled`，再启动新 Session。移除其中一个包后，下一次 Profile 启动只会撤回对应 provider 及其私有运行时闭包。

参见有关[能力家族](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.zh.md)、[可继续执行的子级](../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.zh.md)和[控制工具](../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.zh.md)的决策。

子系统参考——启动请求、结果、实时运行、提供方约定、可续跑后台子 agent——见 [docs/subsystems/subagent.md](../../docs/subsystems/subagent.zh.md)；设计依据见 [subagent 能力 seam](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.zh.md)、[可续跑后台 subagent](../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.zh.md)与[合并 subagent 控制服务](../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.zh.md) Agent Note。


## 概述

subagent 包家族让 agent（智能体）将任务委派给子 agent、继续其工作，并发现自己创建的每个子级。隔离工作可选择全新的进程内子级；需要既有对话时可选择带父级历史的进程内子级；也可选择由 ACP（Agent Client Protocol）、Codex、Claude Code 或另一 Harness 运行时支持的进程外子级。面向模型的工具还让 agent 能够向相邻 agent 发送消息、中断工作并列出子级状态。无论子级正在运行还是已存储，父级都能看到它；各包 README 说明各提供方特定的设置与限制。
