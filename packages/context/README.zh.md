# context/ — 请求上下文扩展

[English](README.md) | 中文

在不定义工具的情况下添加模型可见的请求上下文的产品插件。`agent-instructions` 包含在默认 `dsh-agent-spine-demo` 组合包中，可通过组合包配置禁用；`time-context`、`tmux-context`、`session-reference`、`file-reference` 和 `file-reference-local` 需主动启用。

| 包 | 职责 | ctx key |
|---|---|---|
| [`session-reference/`](session-reference/README.zh.md) | 其他会话的有界快照 | `ctx.sessionReferenceResolver` |
| [`file-reference/`](file-reference/README.zh.md) | 文件引用发现 seam 与 `@file` 语法 | `ctx.fileReferences` |
| [`file-reference-local/`](file-reference-local/README.zh.md) | 本地文件系统文件引用提供方 | — |
| [`time-context/`](time-context/README.zh.md) | 当前时间与耗时上下文 | — |
| [`tmux-context/`](tmux-context/README.zh.md) | tmux 位置上下文 | — |
| [`agent-instructions/`](agent-instructions/README.zh.md) | 工作区指令上下文 | — |
| [`userdoc-context/`](userdoc-context/README.zh.md) | 用户上传文档的准入上下文 | `userdoc/attached` |

会话引用见 [docs/subsystems/session-reference.md](../../docs/subsystems/session-reference.zh.md)；[`agent-instructions` 决策记录](../../.agents/notes/implemented/feature/2026-06-24-workspace-context.zh.md)规定了其按 agent（智能体）/会话隔离与生命周期拆分。


## 概述

context 组提供不定义任何工具、为每次请求添加模型可见上下文的插件：工作区指令文件成为指引，`@file` 提及提供路径补全，其他会话可以作为有界快照被引用，模型还能看到当前时间与 agent（智能体）的 tmux 位置。除 `agent-instructions`（`dsh-base` 默认包含它，profile patch 可以禁用）外，其余全部需主动启用。上下文是持久的：注入的指令与引用以用户角色消息的形式进入会话历史，因此与其他对话内容一样持久保留、可回放、可压缩。本页概述本组；包级约定由各包 README 负责。
