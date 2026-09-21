# test-support/：开发和测试基础设施

[English](README.md) | 中文

这些包为仓库开发、测试和示例提供支持，而不是产品 API。其兼容性取决于所服务的开发需求。

| 包 | 职责 |
|---|---|
| [`acp-snapshot/`](acp-snapshot/README.zh.md) | 提供 ACP（Agent Client Protocol）快照测试工具包 |
| [`agent-loop-testkit/`](agent-loop-testkit/README.zh.md) | 为 AgentLoop 测试挂载共享先决条件 |
| [`invariants/`](../runtime-diagnostics/invariants/README.zh.md) | 运行开发期运行时约定断言 |
| [`loader-smoke/`](loader-smoke/README.zh.md) | 启动由 Loader 组合的应用以执行冒烟测试 |
| [`llm-mock-server/`](llm-mock-server/README.zh.md) | 提供确定性的 OpenAI 兼容故障服务器 |
| [`llm-replay/`](llm-replay/README.zh.md) | 为无密钥测试和演示回放已记录的模型响应 |

当一个包获得产品约定和产品消费方时，它会移出 `test-support/`。

不变式约定记录在 [docs/subsystems/invariants.md](../../docs/subsystems/invariants.zh.md)。


## 概述

test-support 组为仓库测试提供确定且无须密钥的真实产品测试方式。它包含 Loader 应用 harness、session-log 快照适配器、回放 LLM 插件和可通过脚本控制的 OpenAI 兼容故障服务器。每个包都是支持层基础设施；当某个包获得产品约定与产品消费方时，它就会移出本组。
