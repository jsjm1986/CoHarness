# Agent Note: 取消时等待原生辅助进程终止

Status: implemented

[English](2026-10-29-native-command-cancellation.md) | 中文

## Problem

原生命令的取消错误可能在辅助进程仍存活时返回。调用方若把拒绝当作取消完成，就可能丢弃活动选择器或主机命令的唯一所有者。忽略 SIGTERM 的辅助进程可确定性地复现此故障。

## Decision

[原生命令执行器](../../../../packages/util/native-command/src/runner.ts) 持有直接辅助进程，直到其发出 `close` 事件。取消发送 SIGKILL，命令 Promise 保留到进程终止且捕获的输出流关闭。取消订阅也在该完成点移除。执行器直接持有取消订阅，不向 Node 的 `execFile` 传入 `signal`：创建失败的错误到达前，未分配的原生句柄可能指向 POSIX 进程组零。只有已分配 PID 的子进程才会收到信号。调用前已取消时不创建进程，保留公开的 `ABORT_ERR` 代码和空输出流。

正常输出与错误字段保留既有含义。执行器仍是主机集成使用的库，位于 Session 模型与进程工作负载准入之外。[目录选择能力](../architecture/2026-07-28-directory-picker-capability-seam.zh.md) 与桌面移交保留各自的交互和应用生命周期。

## Alternatives considered

**取消回调触发后立即返回。** 错误仅表明取消意图，不能证明辅助进程已终止，因此调用方可能丢失清理所有权。

**只设置 execFile 的 killSignal。** 该选项控制 execFile 自身的终止路径，但在受支持的 Node 实现中，不配置底层 AbortSignal 取消行为。

**持有辅助进程打开的全部应用。** 桌面移交有意将所选应用交给用户桌面。临时命令继续受管；已移交应用具有独立生命周期。

## Consequences

取消等待辅助进程关闭后，调用方才能释放操作。忽略信号的辅助进程不能在取消返回后继续占据原生命令槽位。公开执行器签名、输出字段和错误代码保持兼容。原生桌面与 Windows 终止仍需按平台验证。

## Testing

真实 POSIX 子进程先安装 SIGTERM 处理器，再发布就绪状态。回归取消它，核验公开取消错误，并记录返回前进程已经消失。即使断言失败，清理也会终止并等待该测试进程。适配器测试发出真实 execFile API 所提供的异步回调和关闭事件。更广的选择器、路径打开和应用解析测试保留既有行为。
