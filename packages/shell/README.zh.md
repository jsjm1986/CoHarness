# shell/ — bash 能力家族

[English](README.md) | 中文

该能力家族涵盖规范执行器 seam、其实现、共享 shell 环境和面向模型的工具。这些全是**产品**包。

| 包 | 职责 | ctx key |
|---|---|---|
| [`shell/`](shell/README.zh.md) | 定义 Service Provider 与 Consumer 共享的执行器约定。 | `ctx.shell` |
| [`bash-local/`](bash-local/README.zh.md) | 通过本地 [`subprocess`](../subprocess/README.zh.md) 服务执行命令。 | （注册 `ctx.shell`） |
| [`bash-sandbox/`](bash-sandbox/README.zh.md) | 在本地执行前应用已配置的 [`sandbox`](../sandbox/README.zh.md) 后端。 | （注册 `ctx.shell`） |
| [`pwsh-local/`](pwsh-local/README.zh.md) | 采用 Windows 特有的进程行为执行 PowerShell 命令。 | （注册 `ctx.shell`） |
| [`shell-env/`](shell-env/README.zh.md) | 提供 shell 工具共享的托管 `DSH_*` 环境。 | `ctx.shellEnv` |
| [`tool-bash/`](tool-bash/README.zh.md) | 向模型公开 Bash 执行和后台任务集成。 | （注册到 `ctx.tools`） |
| [`tool-pwsh/`](tool-pwsh/README.zh.md) | 向模型公开 PowerShell 执行。 | （注册到 `ctx.tools`） |

叶节点 `cordis.yml` 选择一个执行器实现和所需的面向模型工具。沙箱化组合还会选择一个 `ctx.sandbox` 提供方；[ACP（Agent Client Protocol）示例](../../examples/acp-agent/)展示一套完整接线。

子系统参考——请求/spec 词汇、结果、后台进程、服务与事件——见 [docs/subsystems/shell.md](../../docs/subsystems/shell.zh.md)。


## 概述

shell 组为 agent（智能体）提供命令执行能力：运行前台命令并读取其有界输出，或启动后台进程并轮询它——在 POSIX 上用 Bash，在 Windows 上用 PowerShell。每个组合恰好挂载一个执行器实现；沙箱执行器会通过沙箱能力限制每条命令，面向模型的 `bash` 与 `pwsh` 工具则位于所挂载执行器之上。POSIX 选择 Bash 执行器，Windows 选择 PowerShell 执行器；命令需要文件级隔离时选择沙箱变体。
