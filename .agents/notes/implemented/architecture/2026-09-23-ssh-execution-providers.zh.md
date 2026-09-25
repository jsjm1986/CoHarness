# Agent Note：SSH 执行提供方

Status: implemented

[English](2026-09-23-ssh-execution-providers.md) | 中文

## Problem

远端工作区要求文件系统身份、进程路径、终端和沙箱政策指向同一执行目标。远端路径不得授权访问 Host 上的同名文件。[可移植消费者决定](2026-07-28-portable-execution-world-consumers.zh.md)定义了这些接口。

## Decision

四个 [SSH 提供方](../../../../packages/ssh/README.zh.md)采用上游 alpha.2 实现。部署方管理的一条 OpenSSH 连接承载管理 RPC 和独立认证的程序流。预装 helper 及可选 PTC bootstrap 必须符合配置摘要；严格主机校验和禁止 Agent 转发仍为强制要求。

提供方保留受保护文件写入、异步启动、取消和受管进程清理语义。断连操作在独立观察前结果未知；连接不会自动重连或重放。模型凭据与 Session 持久化保留在 Harness 主机。远端 helper 禁止通过 SIGUSR1 激活调试器。

传输服务不授予产品访问权。Gateway 侧的执行面落在 `gateway/src/postgres/ssh-target-service.ts`，基于迁移 038：`resolveForRuntime` 在单个 PostgreSQL 事务内完成主体授权与目标配置读取，资格与配置不会分叉；`share` 同时锁定用户行与成员行，并发的角色降级不能保留过期共享。运行时侧的 `GatewaySshAuthorization`（`packages/context/gateway-execution/src/ssh.ts`）只通过签名的 `/internal/runtime/ssh/resolve` 路由解析，在每次请求前记录失效纪元，撤权后到达的响应一律拒绝；每个已解析目标携带 AbortSignal，所属授权在失效时中止它。个人密码和密钥由凭据服务管理，不得进入模型参数、命令参数、普通环境变量或 Session 数据。

文件系统适配器通过经过验证的 helper 请求传递 CoHarness 的源版本守卫和目录枚举上限。预览缓存不能替代已经变化的源文件，小列表也不应枚举所有远端条目。这些 helper 修改要求配置匹配的产物摘要。

## Alternatives considered

仅使用 SFTP 无法保留现有原子编辑、沙箱与进程语义。让程序输出经过管理帧需要另一套流控协议；独立 SSH 通道保留传输层背压。迁移整个 Harness 也会迁移凭据与 Session 存储，属于另一种部署模式。

## Consequences

两端均要求 Linux 或 macOS，以及预装 helper。源码对齐和协议测试证明提供方行为，不代表真实 SSH、Gateway 授权或远端 Web 已验收。每个消费者必须使用提供方路径，每个 UI 资源必须保留账号、runtime、Session 和执行目标。现有工作区资源服务继续负责 Web 读取。无法投影 Host 路径的文件系统由该提供方解析并校验项目根目录。POSIX 文件解析保留符号链接后的物理父目录遍历；有界目录枚举和带版本校验的读取继续作为本地扩展保留。

## Verification

协议测试覆盖无效输入、容量、取消、流认证与清理。真实验收还需要实际 SSH、已安装 helper、沙箱隔离、文件变更、终端和 PTC 通信，以及断连清理。产品验收必须覆盖凭据与资格撤销，以及远端预览、diff 和交付物卡片；这些义务在实际入口得到验证之前保持未完成。

可移植消费者注记仍然有效。本次提供方接入没有完全替代任何现役注记。
