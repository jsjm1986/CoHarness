---
description: "面向组合 POSIX 文件、进程与沙箱提供方的部署者，说明 OpenSSH 连接配置及远端辅助进程生命周期。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh

[English](README.md) | 中文

## 概述

`dsh-ssh` 将 POSIX Harness 主机连接到 POSIX SSH 主机上已安装的辅助程序。部署方持有的 OpenSSH 主机别名提供认证与主机身份；配套的文件系统、子进程和沙箱提供方共享该连接。连接在就绪前验证已安装产物的摘要；辅助程序在连接关闭或租期到期时负责远端清理。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在自定义 `dsh` 配置组合中，将本服务与 [`fs-ssh`](../fs-ssh/README.zh.md)、[`subprocess-ssh`](../subprocess-ssh/README.zh.md) 和 [`sandbox-ssh`](../sandbox-ssh/README.zh.md) 组合。主机运行 Harness、模型传输和 Session 存储；远端机器提供文件与进程。headless 配置组合支持这种安排。

### 部署前提

两端均需运行 Linux 或 macOS。本地 `ssh` 命令必须支持连接复用与 Unix 套接字转发，服务器也必须允许该转发。启动前配置主机别名、凭据与已知主机记录：本服务启用 `BatchMode`、要求严格检查主机密钥、禁用认证代理转发，且不提供交互认证流程。把主机服务转发到远端回环端口的消费者还要求服务器允许 TCP 远端转发并遵守请求的回环绑定（`GatewayPorts no` 或 `clientspecified`）。

安装 [SSH helper 可执行文件发行包](../ssh-helper-runtime/README.zh.md)，或已构建的 helper 脚本及其匹配的 Node 依赖。运行时必须位于工作区和可写临时目录之外，也必须位于后端会替换的临时目录树之外，例如 bwrap 的私有 `/tmp`；工作区仍可位于 `/tmp` 下。摘要校验在辅助程序启动后发现非预期的已安装产物；它不能保证可写部署文件的执行安全，也不能认证恶意 SSH 主机。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `host` | 必填 | 已有的 OpenSSH 主机别名 |
| `launch` | 必填 | `{ kind: "executable" }`，或 `{ kind: "node-script", node: "/absolute/node" }` |
| `helper`、`workspace` | 必填 | 远端 helper 入口和默认工作区的绝对路径 |
| `passwordRef` | 省略 | 经 `SSH_ASKPASS` 读取的凭据引用；不进入 argv、进程环境、会话数据或日志 |
| `helperHash` | 必填 | 已安装辅助程序入口的小写 SHA-256 |
| `launch.bootstrapPath`、`launch.bootstrapHash` | 省略 | 成对提供的远端 PTC 脚本及摘要；仅用于 `node-script` |
| `requestTimeoutMs` | `30000` | 连接与管理请求的截止时限，范围为 1 至 2,147,483,647 毫秒 |
| `maxFrameBytes` | `67108864` | 每条 JSON 消息的负载上限，最大为 64 MiB |
| `maxPending` | `128` | 普通未完成请求的数量上限；心跳与有界清理请求使用预留容量 |
| `leaseMs` | `30000` | 辅助进程心跳租期，范围为 3000 至 600000 毫秒 |

将验证后的 `ctx.ssh.ptcLaunch` 作为 [`NodePtcRuntime`](../../ptc-runtime/ptc-runtime-node/README.zh.md) 的 `launch` 配置。可执行文件部署包含 worker；脚本部署使用 PTC 时需要两个引导字段，仅使用文件系统和 Bash 时可以省略。脚本引导未配置时，getter 会拒绝访问。客户端在就绪前拒绝不匹配的协议版本、运行形式和 helper 摘要。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>


主连接与转发控制命令通过私有隔离的本地子进程提供方运行，即使公开子进程服务采用 SSH，也保持主机执行。托管传输在分配前请求基础设施进程准入，并保留记账直到受管范围确认静止。环境使用子进程凭据清理器；配置的 askpass 路径仍显式传入。

连接通过 `retainConsumer()` 保留每个子进程提供方。返回的清理器会等待已在进行的清理，仅在成功后移除消费者。关闭期间拒绝普通新请求，但已接纳进程的终止与等待继续可用；这些消费者结束后，才关闭辅助程序和本地传输。远端清理失败后仍会释放 Host 载体提供方。

`forwardLoopback()` 为一个本地回环服务分配远端 `127.0.0.1` TCP 监听器。其保留的清理器先等待本地消费者收尾，再取消原始转发请求，并通过随后的一次 helper 往返确认远端取消。调用方取消会等待已经交给 OpenSSH 的分配完成后再回滚，管理请求期限仍然生效。无效的端口分配结果或无法确认的清理会使连接失效，并等待其本地进程退出。失败的所有者保留至关闭时报告。并发所有者不能共享同一本地服务端口。

OpenSSH 主连接承载私有管理 RPC。每条程序流使用独立转发的 Unix 套接字和独立 SSH 通道。转发成功后发生的取消仍会移除该预留。转发取消或本地套接字路径移除失败时，连接会失效，并等待原生传输的退出观察后才报告清理结果。程序 stdout 无法伪造管理回复，也不会占用控制流的通道窗口；SSH 传输拥塞仍会影响共享连接。

每个流预留项都有一个随机 256 位 TLS 预共享密钥，仅由管理 RPC 传递。TLS 认证两端并保护流中的每个字节；密钥绝不作为流前缀发送。套接字目录为私有目录（`0700`），套接字使用 `0600` 权限。替换可写套接字路径无法冒充端点或获知流密钥；攻击者仍可中断服务或转发不透明的 TLS 记录。

连接释放会先等待转发与取消子进程，以及尚在建立的流结束，再删除本地资源。传输丢失会拒绝待处理操作并使连接失效。辅助进程在 SSH EOF、终止信号或心跳到期时启动托管清理。断连客户端无法确认远端结果；操作不会自动重连或重放。

启动或进程结果失败后，预留项在原生进程范围清空后释放；有界完成缓存保留原始拒绝结果，供后续读取。辅助程序的关闭调用共享同一轮清理，并保留失败的端点或目录清理供重试。关闭开始后仍拒绝普通操作；后续 close 请求可以重试清理，但不会重放程序效果。只有进程清理成功后，辅助程序才会释放本地 provider 并移除私有根目录。

终端启用 shell 活动观察时，根进程退出会保留 reservation 及其剩余工作。活动 RPC 继续访问 provider；明确终止时先等待进程范围完全停稳，再释放端点并记录完成结果。helper 连接卸载和租约到期仍保留原有的终止权限。

连接会禁用 helper 的 SIGUSR1 调试器激活：脚本调用使用 `--disable-sigusr1`，可执行文件调用通过 `NODE_OPTIONS` 提供该标志。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 子系统](../../../docs/subsystems/ssh.zh.md) — 执行坐标、传输语义及生命周期归属。
- [POSIX SSH 决策](../../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.zh.md) — 理由、替代方案及必要验证。

-----

<a id="model-experience"></a>
## 模型体验

无，因为主机别名、认证与流能力令牌属于私有部署细节，每项面向模型的操作均由消费方负责。

#### KV Cache 影响

本提供方不贡献请求前缀内容。面向模型的工具与结果由消费方负责。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 不提供 Windows 端点、自动配置远端环境、重连或重放。
- Web 工作区界面的路径仍假定可访问主机文件系统；请使用 headless 或所有消费方都遵守提供方路径语义的自定义组合。
- TLS 流密钥不防御远端操作系统级进程内存检查或调试。文件效果策略保留所选沙箱后端的限制。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
