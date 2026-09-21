# terminal/：持久 PTY 能力家族

[English](README.md) | 中文

`PTY` 的全称是 **Pseudo-Terminal（伪终端）**。这项能力提供持久且限定所有者范围的终端会话，适用于需要跨工具调用保留状态或使用交互式 stdin 的工作流。PTY 是单次 bash 与文件系统工具的补充，不会取代后两者更严格的逐操作约定。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`pty`](terminal/README.zh.md)（`@deepseek-ai/dsh-terminal`） | 后端注册表、品牌化 id、精确的 Agent 所有权、会话操作与等待完成的清理 | `ctx.terminals` |
| `terminal-bash`（`@deepseek-ai/dsh-terminal-bash`） | `ctx.subprocess.spawnTerminal` 之上的 shell 后端：就绪检测、有界终端状态、沙箱策略与会话操作 | 注册到 `ctx.terminals` |
| `tool-terminal`（`@deepseek-ai/dsh-tool-terminal`） | 6 个面向模型的工具，并为后台发送集成通用任务 | 注册到 `ctx.tools` |

设计与暂缓边界记录在[持久 PTY Agent Note](../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.zh.md) 中。

子系统参考——id、后端/会话约定、发送就绪、有界读取——见 [docs/subsystems/terminal.md](../../docs/subsystems/terminal.zh.md)；设计与暂缓边界见[持久 PTY Agent Note](../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.zh.md)。


## 概述

`terminal/` 家族让 agent（智能体）的交互式 shell 和 REPL 会话跨工具调用持续存在，包括工作目录、环境变量和运行中的子进程。使用 `terminal/` 管理所有者隔离的会话，使用 `terminal-bash/` 启动受沙箱约束的交互式 bash 或 pwsh 会话，使用 `tool-terminal/` 获得 6 个结果有界的面向模型终端操作。任务需要交互式输入或需要保留单次 bash 命令无法保存的状态时，选择这个家族。会话仅存在于一个 harness 进程中，重启后不会恢复。
