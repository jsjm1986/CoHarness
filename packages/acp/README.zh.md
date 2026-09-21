# acp/：Agent Client Protocol 自动化

[English](README.md) | 中文

ACP（Agent Client Protocol）组通过该协议将 harness 中的 agent（智能体）公开给程序化客户端。它是互操作传输层，不是展示或人机交互层；配对的进程外 subagent *客户端*在 [`subagent/subagent-acp`](../subagent/subagent-acp/README.zh.md)，因为它实现的是 subagent 提供方接口。

| 包 | 职责 |
|---|---|
| [`acp/`](acp/README.zh.md) | 仅面向自动化的 ACP 服务器。 |

服务器约定见 [`acp/README.md`](acp/README.zh.md)。


## 概述

acp 组提供一个包：一个服务器，让程序与自动化流程可以通过标准 Agent Client Protocol 运行持久 DeepSeek Harness agent。客户端可以创建、列出、恢复与关闭会话，挂载标准 MCP 服务器，选择模型选项，发送文本与图片提示词，接收语义更新，响应权限提示并取消工作——无需人类参与。从另一个 harness 启动这种服务器的配套客户端位于 `subagent/subagent-acp`。本页概述该包组；各包的具体约定由其 README 规定。
