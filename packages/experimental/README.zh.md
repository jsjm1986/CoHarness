---
description: "以实验性名称发布、与默认产品依赖隔离的实验性 Cordis 插件和运行时库。"
kind: "package-group"
---

# experimental/：实验性包

[English](README.md) | 中文

本组包含采用实验性约定的 Cordis 插件和运行时库。除发布策略排除的包外，组内包随 dsh 发布家族发布；发布不代表稳定性或支持承诺。组内包仍须满足与发布包相同的工程、安全、文档、生命周期、测试和快照要求。

| 包 | 职责 | ctx key |
|---|---|---|
| `agent-team/` | 隐式 root Agent Teams roster、持久 peer mailbox、共享任务 DAG 与运行时协调 | `ctx.agentTeams` |
| `tool-agent-team/` | 按 Agent 作用域提供的 Agent Teams 模型工具与协作指引 | — |
| [`ptc-runtime-python/`](ptc-runtime-python/README.zh.md) | 代码执行 seam 的 CPython 子进程后端 | `ctx.ptcRuntime` |

[子树规则](AGENTS.md)规定依赖隔离、发布策略与 promotion。

[Agent Teams 子系统页](../../docs/subsystems/agent-team.zh.md)负责持久 Team 类型与 `ctx.agentTeams` 服务 API。

## 概述

实验组包含约定可能变更且不提供支持承诺的原型能力。所有当前包都以 `@deepseek-ai/dsh-experimental-*` 名称发布，包括显式启用的 Agent Teams 组合、Auto review、Cua Driver 提供方、浏览器操作后端、跨 realm Inspector、CPython PTC 后端与浏览器 worker 预览库。组外已发布产品不得依赖实验性包。
