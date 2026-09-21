# plan/：plan 协作状态

[English](README.md) | 中文

Plan mode 是按 agent（智能体）记录的协作状态，而不是通用模式注册表或能力 seam。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`plan-mode/`](plan-mode/README.zh.md) | 负责 plan mode 状态、指引、命令和评审流程 | `ctx.planMode` |

[plan 专用协作状态](../../.agents/notes/implemented/simplification/2026-07-22-plan-specific-collaboration-state.zh.md)决策记录了该家族的设计。

子系统参考——`plan/mode` 折叠、步骤边界刷写、配置、退出工具——见 [docs/subsystems/plan.md](../../docs/subsystems/plan.zh.md)；设计见[计划专属协作状态](../../.agents/notes/implemented/simplification/2026-07-22-plan-specific-collaboration-state.zh.md)。


## 概述

`plan/` 组提供计划模式：激活期间，agent 先探索和设计再执行，遵循部署写入的指令，并在执行前提交完成的计划供你批准。你可以用 `/plan` 命令进入和离开计划模式，批准计划，或让 agent 回去继续规划。计划模式是引导而非限制：每个工具仍然可用，沙箱模式与审批提示等限制需另行配置。该组只包含一个包 `plan-mode`。
