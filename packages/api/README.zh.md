# api/：Remote API 层

[English](README.md) | 中文

面向应用的 Remote 技术栈。`remotes` 负责 BFF 策略和选定的业务 API，`gateway` 则实现 Host 与 Client 环境共用的 Typert 一元 RPC endpoint。

| 包 | 职责 | ctx key |
|---|---|---|
| [`remotes/`](remotes/README.zh.md) | Host Agent/Session lookup 策略与 Client Remote contribution 装配 | 无服务；配置 `ctx.typert` 并消费 `ctx.remote` |
| [`gateway/`](gateway/README.zh.md) | Host Typert 分发器与 Client Remote endpoint | `ctx.typertGateway` / `ctx.remote` |

运行时依赖方向为 `remotes → gateway → connection → webserver`：BFF 消费共享的 `TypertClientRemote` 约定，Gateway 把传输交给 Connection，Connection 再挂载到 HTTP server。Cordis 服务注入与 Client 模块元数据在不让 Remotes Client 入口导入具体 Gateway 实现的前提下维持该顺序。

## 概述

`api/` 组提供应用的 Remote 层：Client 环境可以调用运行在 Host 上的业务能力——管理目标、运行命令、查看插件清单、发现文件与会话引用——调用方式是类型化方法，并接收结果或转发的 Host 事件。`remotes` 决定暴露哪些能力、以及每次调用如何到达正确会话的 agent；`gateway` 在 Client 与 Host 之间承载调用及其结果。技术栈运行在应用共享的 Connection 之上；流式会话数据刻意不在其中。

## 已知限制与延期工作

- Connection 与 WebServer 仍位于 [`client/connection`](../client/connection/README.zh.md) 和 [`host/webserver`](../host/webserver/README.zh.md)；后续可以只移动包，将它们放到 `api/connection` 和 `api/webserver` 下，而无需改变服务约定。
- 旧 API Proxy 仍位于 [`host/apiproxy`](../host/apiproxy/README.zh.md)，作为尚未迁移到 Remote 的方法的回退路径。它使用由 `api-remotes` 持有的 Host resolver，使已迁移与旧方法共用同一套 Agent/Session 身份策略。

[Typert 子系统参考](../../docs/subsystems/typert.zh.md)记录了协议、Gateway 与消费方装配共享的公共契约。
