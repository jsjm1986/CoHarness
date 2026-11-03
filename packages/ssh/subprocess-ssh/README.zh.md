---
description: "面向 Bash、LSP 及 Node 运行时消费方，说明托管 SSH 子进程与终端行为。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subprocess-ssh

[English](README.md) | 中文

## 概述

`dsh-subprocess-ssh` 使用共享 SSH 辅助进程实现 `ctx.subprocess`。可执行文件查找、普通进程、fd 7 控制流及终端会话与 SSH 文件系统在同一环境中运行。远端原生进程管理器负责终止与静止状态；消费方继续负责命令语义、输出上限与执行截止时限。

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

将本提供方与 [`dsh-ssh`](../ssh/README.zh.md) 及其文件系统提供方一同挂载。本提供方没有独立部署配置。`resolveExecutable()` 检查远端可执行文件命名空间；完整的 spawn 请求提供远端 cwd、环境、流处置方式及清理宽限期。

普通 spawn 在远端分配过程中返回句柄。管道 stdin 和可选双工控制端点在分配过程中接受写入。终端分配、写入、前台检查、信号及终止均保留异步接口。

终端请求将 `shellActivity` 转发给执行 provider，`inspectActivity()` 返回经校验的状态和 revision。启用后，根进程退出的终端仍可访问，直到 owner 明确终止；连接级清理仍由 SSH helper 租约控制。

终端请求信号用于取消分配。句柄发布后，由调用方明确终止；提供方释放与节点许可撤回仍保留终止权限。提供方把共享的静止清理注册到 SSH 连接，使上层所有者释放时，传输一直可用到最后的进程终止或等待完成。

`done` 报告的直接进程退出并不证明托管进程范围已经静止；`waitForExit()` 单独观察该状态。其可选信号约束整个观察过程，包括等待分配和终止；取消返回 `false`，不会停止进程。已确认清空的范围返回 `true`，实际观察故障则拒绝。`terminate()` 针对同一个远端管理器。连接丢失会拒绝未确认的操作；启动或修改结果不明确时绝不自动重放。

-----

终端 shell 信息与可执行文件验证来自远端 helper。查找未命中与 SSH 故障分别报告。PTY 创建传递调用方的 `terminalType`，`resize()` 更新远端终端尺寸，不替换进程。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

辅助进程在启动前预留并认证全部所需流。stdout、stderr、stdin 与 fd 7 使用独立 SSH 通道。收集输出会发布最终的有界原始字节尾部与完整流字节偏移，因此网络延迟不会改变已完成的观测。可选 spill 文件使用远端本地提供方的私有保留输出目录。

远端执行委托给 [`subprocess-local`](../../subprocess/subprocess-local/README.zh.md)。因此，原生进程归属及平台降级方式与该远端操作系统上的本地执行具有相同含义。SSH 承载请求与观察结果，本身不限制程序权限。

进程准备仅转发辅助程序声明的执行字段。Session 归属、资源来源和取消信号由主机准入所有者保留，不是远端进程参数。

普通进程与终端启动在远端预备和鉴权流连接期间保留主机准入检查，并在 `process.start` 前重新检查。所有者撤销或替换时拒绝派发。确认终端回滚后归还原许可；终止确认失败时保留不确定占用。失败的普通句柄仅在范围停稳且流已关闭后移除，包括 `done` 拒绝的情况。

普通启动逐条记录完成鉴权的流。一路流失败会取消其他分配尝试，等待全部尝试结束，再等待每个已分配套接字关闭，最后拒绝 `done`。即使辅助程序已经确认终止，成功的范围观察与提供方销毁仍保留这段启动清理。观察取消仍有界，并报告清理尚未完成；之后的确认可以完成原许可。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [子进程子系统](../../../docs/subsystems/subprocess.zh.md) — spawn、输出收集、终端及生命周期 API。
- [SSH 沙箱提供方](../sandbox-ssh/README.zh.md) — 远端文件效果限制。

-----

<a id="model-experience"></a>
## 模型体验

间接通过 Bash、终端、LSP 和 PTC 运行时消费方产生影响，由它们展示既有结果与远端路径。

#### KV Cache 影响

本提供方不贡献请求前缀内容。面向模型的工具与结果由消费方负责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 已完成的 spill 文件在连接释放后继续保留，直至外部临时文件清理。
- 调用方必须消费或关闭原始输出流。销毁公开的 stdout 或 stderr 会关闭对应传输，即使销毁发生在远端分配之前也是如此。独立通道允许在 stdout 暂停时继续传输控制消息，但不会消除逐流背压或共享网络拥塞。
- SSH 连接丢失后，客户端无法确认远端终止；租期清理是远端动作，不等于客户端收到了成功确认。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
