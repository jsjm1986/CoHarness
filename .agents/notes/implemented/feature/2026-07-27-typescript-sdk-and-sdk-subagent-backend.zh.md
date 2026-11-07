# Agent Note: TypeScript SDK client and the SDK subagent backend

Status: implemented

[English](2026-07-27-typescript-sdk-and-sdk-subagent-backend.md) | 中文

## Problem

Stdio JSON-RPC 运行时需要 Python 和 TypeScript 两种客户端。启动完整 Harness 运行时的 subagent 后端，需要与普通 SDK 客户端相同的分帧、请求配对、通知作用域和进程清理。如果这些操作留在服务器插件内，每个客户端都必须依赖应用服务包。

## Decision

`dsh-sdk-protocol` 拥有具名请求／结果、通知类型及行传输。服务器与客户端共享这些类型，协议错误保留其协议 code 和 data。包根公开受支持的协议 API，不要求源码模块导入。

`dsh-sdk-client` 拥有 TypeScript 客户端分层：`HarnessClient` 提供协议操作，`DeepSeekHarness`／`HarnessSession` 提供自有 Session 活动。它解析同版本 `dsh` 依赖，并通过具名 profile、有序补丁和可选独立 home 启动。环境对象替换继承值，调用方可以执行凭据策略。客户端库独立于 Cordis 上下文。

`dsh-subagent-dsh-sdk` 是独立 Service Provider，因为其子进程是拥有自身 profile、持久化和工具的完整 Harness 运行时。它复用 SDK 客户端而不重复实现协议。Subagent 服务解析子进程的生效目录，父头保留为原始目录。受支持的路由覆盖值进入初始化，不支持的父级组合控制明确拒绝。提供方的[进程所有者](../architecture/2026-10-24-sdk-subagent-process-ownership.zh.md) 提供受管准入与清理等待，不改变 SDK 协议。

Subagent seam 拥有共享的进程外结果结算与发布。协议驱动拥有其传输、答案提取和安全诊断。进程外子运行时通过流式记录提供结果，不将其记录合并进父对话。

## Testing

所需证据覆盖真实 stdio 交换、自有活动作用域、安全失败事实、取消和已确认的进程清理。可运行 profile 组合通过第二个完整运行时验证配置的子路由与工作目录。无密钥 SDK 场景验证通知投影和持久化 Session 行为；提供方 API 测试单独验证。

## Alternatives considered

**从服务器插件导入协议类型。** 客户端并不服务该应用，却会引入服务器的应用依赖。协议库有真实的服务器与客户端 Consumer。

**每个 subagent 驱动实现原始 JSON-RPC。** 这会重复请求配对、订阅作用域、超时所有权和清理。

**用传输设置合并 SDK 与 ACP 后端。** 两者的子接口、初始化与答案提取不同，只有结果和所有权词汇属于共享 subagent 服务。

**公开内部源码模块和通知生产者。** 调用方需要自有客户端操作，而不是按实现细节修改订阅。公开包根枚举受支持的接口。

## Consequences

两种 SDK 语言投影同一个运行时协议，并保留各自的宿主与分发集成。TypeScript subagent Consumer 不增加第二套协议实现。每个子进程仍启动完整插件树，进程预留不代表该树发出的全部模型请求。因此，运行时策略与资源所有权仍是组合需要明确处理的问题。
