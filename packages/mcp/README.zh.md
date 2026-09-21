# MCP — 模型上下文协议

[English](README.md) | 中文

将 harness 与 MCP 生态系统桥接的包。

| 包 | 职责 |
|---|---|
| [`mcp-client/`](mcp-client/README.zh.md) | MCP 客户端桥接，将外部服务器工具注册到 `ctx.tools` |

[MCP 子系统页](../../docs/subsystems/mcp.zh.md)负责客户端桥接与按需资源契约。


## 概述

`mcp/` 组让模型调用外部 Model Context Protocol（MCP）工具并读取服务器资源。只需配置 `mcp-client` 条目；随附 profile 已统一挂载 `mcp-resources` 一次。只有作用域中存在已配置服务器的调用方才会看到 MCP 工具与提示词文本。连接还会提供服务器指令。配置与限制由各包的 README 说明。
