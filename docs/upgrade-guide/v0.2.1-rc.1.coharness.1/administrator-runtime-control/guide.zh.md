---
kind: upgrade-guide
description: "显式 Runtime 控制保留当前发起管理员权限，并以 HTTP 503 报告数据库容量不足。"
---

# 在 Runtime 控制期间保留管理员权限

[English](guide.md) | 中文

## 变更

个人与项目 Runtime 的启动、停止、重启，在查询、生命周期和准入等待期间保留认证的发起管理员。权限撤销时返回403。不同管理员不共享待完成启动。浏览器项目设置链接在被动启动和热复用期间保留该权限；手动停止的 Runtime 仍要求显式启动。最终个人准入同时检查当前所有者策略和管理员权限。

已经获准的停止可能在撤权前完成。此时重启返回403，并让 Runtime 保持停止。请求被拒绝不会撤销已经获准的取消或停止。保留的 Steward Runtime 精确管理员停止和重启要求当前管理员权限及所选代次，不要求 Steward 数据资格。项目删除仍被拒绝。

有界 PostgreSQL 取连接拒绝返回503，保留可读 `error` 及 `code: DB_CHECKOUT_QUEUE_FULL`。决定是否重试之前重新加载当前状态，因为多阶段操作可能已经完成前面的阶段。

恢复所有者查询、控制器挂接或存活探测不可用时，只读终端和插件清单报告 `503 INSTANCE_UNAVAILABLE`。已记录的 Runtime 代次和常驻占用继续保留；待所有权可确认后重试。

终端和插件管理在 Runtime 派发及响应发布前复核当前管理员。插件普通响应在已配置字节上限内缓存，待清理和授权完成后返回。发布前撤权返回403；已发布获准流式进度后撤权，则在后续片段前中断流。已获准的修改可能已经完成，因此重试前先重新加载状态。

组织停用期间，PostgreSQL 账号读取报告资格已停用，保留存储的账号与成员关系状态以供后续恢复。重新启用组织不会启用独立停用的账号或成员关系。

## 迁移

1. 按[现有流程](../../../../gateway/README.zh.md)部署 Gateway。此管理员控制变更无需新增数据库或 Session 格式迁移。
2. 自定义实例服务在 `ensureRunning(subject, intent, administratorUserId)` 和 `stop(target, reason, administratorUserId)` 中保留传入的管理员 id，包括重启的两个阶段。id 来自服务端认证。只有受信任的内部维护可以省略。
3. 自定义仓库实现 `authorizeAdministrator`、`markControlStopping`，以及 `beginStart` 和 `personalPolicy` 的管理员参数。将当前权限保留至每次意图写入或联合所有者策略读取完成，然后在资源或 supervisor 等待前释放数据库连接。把可选的 `withStopped` 用途传给 `acquireStopLease`：`control` 要求当前管理员权限；省略或 `destructive` 用途保留项目数据保护。两种用途都保留精确代次、节点、Gateway 进程所有权和停止操作检查。
4. 验证目标查询、排队、策略准备、压力等待期间撤权会阻止后续影响；已获准的重启停止之后撤权会让 Runtime 保持停止；当前管理员能控制两种所有者。参见[控制决策](../../../../.agents/notes/implemented/bug-fix/2026-10-29-administrator-runtime-control.zh.md)。
