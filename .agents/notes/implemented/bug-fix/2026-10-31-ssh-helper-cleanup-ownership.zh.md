# Agent Note: SSH helper 在清理失败后仍保留归属

Status: implemented

[English](2026-10-31-ssh-helper-cleanup-ownership.md) | 中文

## Problem

进程的直接结果可能先于端点和目录清理完成。重复关闭若在当前清理结束前返回，就会错误确认已经完成。移除失败的清理任务、永久缓存拒绝的 Promise，或删除所需 provider 和私有现场，都会阻止临时故障恢复后的重试。

## Decision

[远端进程归属](../../../../packages/ssh/ssh/src/helper-processes.ts) 保留稳定且幂等的清理回调，直到清理成功。重叠的关闭调用共享同一轮尝试；失败时保留回调供重试，同时保持准入关闭。已结束进程的原始直接结果与尚未完成的资源清理分别保留。

[辅助程序](../../../../packages/ssh/ssh/src/helper.ts) 在进程清理尚未确认时保留本地 provider 和私有根目录。后续 close 请求可以重试清理，包括最后移除根目录的失败。普通效果仍被拒绝，清理不会重放程序操作。

## Alternatives considered

**在 `finally` 回调中丢弃任务。** 失败的资源清理会从后续关闭尝试中消失。

**将拒绝的 Promise 永久当成完成结果。** 外部故障消失后，重复关闭也无法恢复。

**在 `finally` 中释放 provider 和私有目录。** 消费者可能仍需要这些依赖及原生进程归属证据。

## Consequences

清理成功前，失败始终可见。进程范围观察失败时保留其归属，成功的进程结果仍通过现有有界缓存读取。Host 载体关闭保留独立的传输丢失行为。协议版本 2 和请求字段保持兼容；安装重建后的辅助程序时需要更新已验证的摘要。

## Verification

真实原生进程的成功及失败测试会阻塞目录清理，让重复关闭调用等待，再注入可恢复的删除故障。[Loader 示例](../../../../packages/ssh/ssh/tests/fixtures/cleanup-recovery.mjs) 运行实际辅助程序线协议，重试预留项和根目录清理，验证拒绝新工作，并在资源结算前确认原生进程退出。
