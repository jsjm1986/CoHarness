# hooks/ — 钩子桥接与共享协议

[English](README.md) | 中文

hooks 子系统让用户像使用 Claude Code 和 Codex 一样，在生命周期节点扩展 agent（智能体）：把桥接插件指向现有 `hooks.json`（或设置），即可忠实运行这些外部 shell 钩子。规范扩展接口本身是 harness 的类型化拦截点（参见[拦截扩展点 Agent Note](../../.agents/notes/implemented/feature/2026-06-30-interception-extension-points.zh.md)）；「原生钩子」只是这些扩展点上的普通 Cordis 插件。这些包是把外部 shell 钩子协议转换到同一接口的**桥接**，也包括它们共同依赖的共享协议库。

| 包 | 职责 | 形态 |
|---|---|---|
| [`hook-protocol/`](hook-protocol/README.zh.md) | 共享 shell 钩子协议库 | 库 |
| [`hooks-claude-code/`](hooks-claude-code/README.zh.md) | Claude Code 钩子桥接 | 插件 |
| [`hooks-codex/`](hooks-codex/README.zh.md) | Codex 钩子桥接 | 插件 |

共享库负责通用协议行为；各桥接负责自身方言的事件映射。子 README 记录这些约定。


## 概述

hooks 组让 agent 运行可以复用为 Claude Code 或 Codex 编写的 shell 钩子。把对应集成指向现有的 `hooks.json`，即可在会话开始、提示词到达、工具运行或运行停止时执行受支持的 command hook。这些钩子可以用模型可见消息阻止提示词或工具调用、向对话添加上下文，或要求运行继续。当你需要保留现有钩子配置时，选择本组；每项集成只支持其来源工具所记录的 command hook 子集。
