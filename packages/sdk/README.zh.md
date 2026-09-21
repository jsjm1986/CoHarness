# sdk/：从另一进程驱动 Harness 运行时

[English](README.md) | 中文

本组包含用于从另一进程驱动 Harness 运行时的协议栈。调用方提供运行时可执行文件及其 `cordis.yml`；本组不创建、配置、构建或启动开发者项目。[TypeScript SDK 决策](../../.agents/notes/implemented/feature/2026-07-27-typescript-sdk-and-sdk-subagent-backend.zh.md)负责客户端约定，[工具链移除](../../.agents/notes/implemented/simplification/2026-08-11-remove-sdk-project-toolchain.zh.md)负责产品边界。

| 包 | 职责 |
|---|---|
| [`protocol/`](protocol/README.zh.md) | 定义 SDK 运行时通信协议 |
| [`client/`](client/README.zh.md) | 通过 TypeScript 客户端 API 驱动 Harness 运行时 |
| [`server/`](server/README.zh.md) | 通过 stdio JSON-RPC 为进程外 SDK 客户端提供服务 |


## 概述

SDK 家族让另一进程通过按换行分帧的 JSON-RPC 驱动完整的 DeepSeek Harness 运行时。协议包定义公开消息，TypeScript 客户端用具名 profile 和有序 patch 启动 `dsh`，服务器则通过 stdio 接受 SDK 请求。客户端可以打开会话、发送提示词，并观察会话事件、agent（智能体）状态变化与 subagent 完成事件。TypeScript 客户端与 [Python SDK](../../python/README.zh.md) 使用同一种协议，而这些包不会创建开发者项目，也不定义其他应用。
