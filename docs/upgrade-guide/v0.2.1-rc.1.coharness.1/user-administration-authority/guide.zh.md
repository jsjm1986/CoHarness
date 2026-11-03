---
kind: upgrade-guide
description: "账号管理在等待后、修改账号或删除停机前检查当前权限。"
---

# 为账号变更保留当前管理员权限

[English](guide.md) | 中文

## 变更

账号创建、资料和资格变更、角色或状态更新、密码重置及删除，都要求发起管理员在数据库事务中仍具备当前权限。有效请求若延迟至账号、成员、角色或组织权限失效之后，会返回403。被拒绝的创建不分配账号目录；被拒绝的更新保留账号字段、凭据和会话。

删除在取消排队启动或停止个人 Runtime 之前检查当前权限，并在删除账号数据之前再次检查。停止意图获准后发生的撤权可以保留已停止的账号。[破坏性操作所有权流程](../project-deletion-lifecycle/guide.zh.md) 继续说明替代进程启动、不确定停机及清理失败。

## 迁移

1. 按[既有部署流程](../../../../gateway/README.zh.md)一起部署 Gateway 写入者。除既有的破坏性操作迁移外，无需新增 schema 或 Session 格式迁移。
2. 自定义 `GatewayUserService` 适配器传递服务器认证的 `actorUserId`：`create` 和 `remove` 使用第二个参数；`patch`、`setStatus`、`setRole`、`setDisplayName` 和 `resetPassword` 使用第三个参数。请求字段不能提供参与者。省略时仅供受信任的引导或维护。
3. 在密码哈希和事务准入后验证当前管理员权限，并在写入期间保留账号和成员身份。SQLite 适配器使用即时事务。不要在 Runtime 进程监督期间保留数据库连接。
4. 自定义实例仓库在 `markStopping` 和 `acquireStopLease` 中为个人目标及项目处理参与者。保留既有的稳定 RuntimeId 所有权检查及精确释放规则。
5. 验证撤权后的账号变更返回403，数据和 Runtime 保持原状，当前管理员仍可成功，且禁止自删和最后管理员保护继续生效。自动重试删除前先阅读[权限决策](../../../../.agents/notes/implemented/bug-fix/2026-10-28-user-administration-authority.zh.md)。
