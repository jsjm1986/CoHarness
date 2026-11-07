---
kind: upgrade-guide
description: "项目删除在停机前检查当前权限，并在存储工作结束前持续阻止替代进程启动。"
---

# 保留项目删除权限与停机所有权

[English](guide.md) | 中文

## 变更

管理员项目删除要求在提交停止意图前、移除目录数据前分别具备当前有效的组织管理员权限。撤权后的请求返回403。删除保留的 Steward 返回409，且不停止其 Runtime。在停止意图获准后发生的撤权，可以拒绝目录移除，并保留已停止的项目。

迁移 078 按稳定 RuntimeId 保留 Gateway 所有的破坏性操作。在操作结束前，替代进程启动和节点重分配持续被阻止，即使其他协调器发布了停止状态或删除了活动分配。Gateway 关闭会在注销内核证明前等待操作结束。缺失的确认回执会让保护保留至精确释放或证明所有者已结束。

确认静止后回收预留，同时保留空登记，直至停止状态发布或目录移除。启动失败及死进程恢复也遵循这一顺序。停机失败返回503 `runtime-stop-failed`，不删除目录数据。状态发布、记账或操作释放错误可能发生在删除已提交后，因此重试前需检查当前状态。

## 迁移

1. 遵循既有 [Gateway 部署流程](../../../../gateway/README.zh.md)，在 076–077 之后应用 PostgreSQL 迁移 078，并一起替换旧 Gateway 写入者。无需迁移 Session 格式或请求体。保留既有进程所有权所用的节点本地 Gateway 锁目录。
2. 自定义项目移除路由将服务器认证参与者作为第三个参数传入 `InstanceManager.withStopped`，并作为第二个参数传入 `GatewayProjectService.remove`。请求字段不能提供该身份。
3. 自定义 PostgreSQL `InstanceManager` 组装将 `GatewayModelBudget` 作为第六个构造参数传入。其 `withOwnership` 不消耗模型额度，持续持有管理回调。分布式仓库实现 `acquireStopLease` 和 `releaseStopLease`；获取操作在一个事务中保留当前管理员权限及可删除分配。本地测试适配器继续支持 `markStopping` 的可选参与者参数。省略时仍表示受信任的生命周期维护。
4. 记账适配器处理 `stopped` 的登记阶段。retain 释放预留，但保留不可执行的空登记；remove 在分配状态发布或移除后清理该登记。
5. 验证撤权后的删除保留项目数据及热 Runtime、Steward 删除返回409，以及正常删除在移除目录记录时保留宿主机文件。自动重试前先阅读[失败与所有权决策](../../../../.agents/notes/implemented/bug-fix/2026-10-28-project-deletion-lifecycle.zh.md)。
