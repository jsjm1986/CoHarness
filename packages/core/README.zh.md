# core/ — 产品 API 主干

[English](README.md) | 中文

构成 harness 默认控制主干的会话日志、系统提示词组装、工具注册表、agent（智能体）词汇、部署默认模型选择和具体循环。这些是**产品**包，即插件和消费方构建所依赖的稳定接口。

| 包 | 职责 | ctx key |
|---|---|---|
| [`scope/`](scope/README.zh.md) | 作用域上下文注册原语 | 库，不使用 ctx key |
| [`session/`](session/README.zh.md) | 事件溯源会话日志和内存存储 | `ctx.sessions` |
| [`system-prompt/`](system-prompt/README.zh.md) | 提示词和工具 schema 组装注册表 | `ctx.systemPrompt` |
| [`tools/`](tools/README.zh.md) | 作用域工具注册表和执行流水线 | `ctx.tools` |
| [`agent/`](agent/README.zh.md) | Agent 接口、注册表和事件词汇 | `ctx.agents` |
| [`agent-default-model/`](agent-default-model/README.zh.md) | 各 Agent 入口共享的默认模型选择 | `ctx.agentDefaultModel` |
| [`agent-loop/`](agent-loop/README.zh.md) | 默认具体 agent 驱动器 | `ctx.agentLoop` |

`scope` 提供共享作用域原语。`agent` 负责公开约定，`agent-loop` 是其默认实现；扩展插件依赖该 seam，从而保持驱动器可替换。`agent-default-model` 负责部署选择，Agent 入口仅在会话自身没有选择时使用它。

可运行组合属于 [`examples/agent-spine-demo`](../examples/agent-spine-demo/README.zh.md)；该分组只负责可替换的主干组件。

子系统参考——逐包循环图、`Agent` 句柄及其投递／拦截约定——见 [docs/subsystems/core.md](../../docs/subsystems/core.zh.md)；默认可运行组合是 [`examples/agent-spine-demo`](../examples/agent-spine-demo/README.zh.md)。


## 概述

使用 core 包可以构建或扩展能够记录持久会话历史、组装系统提示词、提供工具、选择默认模型并运行模型轮次的 agent。这些包定义每个组合都会使用的共享 API，而可执行的产品组合位于 [`packages/bundle`](../bundle/README.zh.md)。开发 agent 行为或替换其中一项能力时请选择本分组；需要默认可运行组合时，请从 [`dsh-base`](../bundle/base/README.zh.md) 开始。
