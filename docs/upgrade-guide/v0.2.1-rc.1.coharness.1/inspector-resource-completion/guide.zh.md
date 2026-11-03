---
kind: upgrade-guide
description: "Inspector 清理可在资源记账确认被拒绝后重试完成请求。"
---

# 升级 Inspector 清理归属

[English](guide.md) | 中文

## 变更

Worker 退出后的资源完成请求失败时，`InspectorHandle.close()` 和 `InspectorStartupCleanupError.cleanup()` 保留清理责任。再次调用会重试尚未确认的完成请求。并行调用共用未完成工作，成功完成保持幂等。

插件启动在进程准入前保留资源提供者。原生分配前提供者被移除或替换时，以 `ResourceAdmissionError` 的 `unavailable` 原因拒绝，并将未使用的许可归还原所有者。未使用许可的完成失败也会转交可重试清理；启动取消和清理失败一起保留。程序化调用方可以提供可选的 `InspectorAdmission.assertOwnership` 来核对当前所有者。

## 迁移

1. 升级完整 Inspector 包及其 Worker 构建。现有选项和方法签名不变。
2. 调用被拒绝时保留句柄或转交的清理。解决记账器故障后再次调用；套接字关闭本身不代表容量已经释放。
3. 确认 Worker 端点已关闭且记账器已经确认完成，再丢弃所有者。见[资源归属](../../../../.agents/notes/implemented/bug-fix/2026-10-29-inspector-resource-completion.zh.md)。
4. 归属检查被拒绝后，恢复准入并重新启动。不要将旧许可转移给替代提供者。
