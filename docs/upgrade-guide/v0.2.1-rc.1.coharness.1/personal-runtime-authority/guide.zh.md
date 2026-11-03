---
kind: upgrade-guide
description: "个人 Runtime 启动刷新当前账号权限，Admin 准入失败使用对应类型的 HTTP 状态。"
---

# 在启动等待后刷新个人 Runtime 权限

[English](guide.md) | 中文

## 变更

个人 Runtime 启动在容量准入后解析当前符合条件的账号，并在节点压力准入后再次检查身份、主目录及角色。准备期间发生变化会在进程分配前返回503；新请求可按当前角色准备。热策略刷新也使用当前资格和角色。已经运行的进程仍遵循现有撤权与停止收敛规则。

Admin Runtime 准入错误保留可读的 `error` 文本，并提供 `code`。策略不可用或容量不足返回503（`INSTANCE_UNAVAILABLE` 或 `INSTANCE_CAPACITY`）；持久停止状态与资源代次失配返回409。Linux 账号准备失败时，账号缺失返回409 `RUNTIME_ACCOUNT_NOT_PROVISIONED`，查询不可用返回503 `RUNTIME_ACCOUNT_VERIFICATION_UNAVAILABLE`，并提供准备指引。把所有启动失败都视为400或500的客户端需要处理这些状态。

PostgreSQL 活动租约先取得分配行锁，再检查当前资格；等待期间撤权会拒绝准入。资源记账与活动以配置的语句超时约束锁等待；语句不设限时保留连接池的锁超时。争用耗尽返回503，资源 HTTP 路由使用 `resource-database-busy`，不自动重放或释放预留。

## 迁移

1. 按[现有部署流程](../../../../gateway/README.zh.md)一并部署 Gateway 写入端和启动器，无需额外的数据库或 Session 格式迁移。
2. 自定义实例仓库实现 `personalPolicy(id)`，检查当前活跃账号、组织成员资格及节点分配；`snapshotOf(target)` 同时读取分配、状态、端口和代次，拒绝有歧义的选择器；`admitLease(target, at, generation?)` 原子检查当前资格并更新活动。Gateway 实例适配器实现 `liveEndpoint(target)`，检查当前监督状态与资源登记；转发之前仍需对其端点执行捕获代次的活动准入。自定义启动器在分配进程或发出原生启动命令前等待 `beforeAllocation`。
3. 实现 `markExpiredConnectionStopping(target, generation, administratorUserId?)`，以带条件的停止意图更新明确的过期受管连接；本地、当前有效及替换代次保持不变。传入管理员身份时，授权检查覆盖该修改。重新进入必须先确认旧进程终止，再由正常启动签发新凭据；不得修改运行中代次的连接绑定来恢复它。
4. 保留现有账号撤权与确认停止流程。被拒绝的准备可能留下策略文件；文件存在不证明进程运行，也不授权复用。
5. 验证排队期间降权后启动普通 Runtime、策略或压力准备期间降权拒绝分配，以及符合条件的新请求能以受限策略成功运行。验证节点租约恢复保留 Runtime 身份和数据、拒绝旧凭据，且不能在终止未确认时启动替代进程。自动重试前阅读[权限决策](../../../../.agents/notes/implemented/bug-fix/2026-10-28-personal-runtime-authority.zh.md)。
