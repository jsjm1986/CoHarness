---
kind: upgrade-guide
description: Admin JSON 读取在发送数据及元数据响应头前要求当前账号资格。
---
# JSON 读取使用当前管理员资格

[English](guide.md) | 中文

## 变更

Admin JSON 回应器在异步数据准备后检查当前管理员资格，包含组织、成员资格、账号、角色及要求修改密码的变化。已撤权读取收到403，不返回选中数据、审计总数或归档附件名称。账号查询不可用时返回503及 `admin-authorization-unavailable`。GET、HEAD 读取，以及备份配置预览等显式选择的 POST 诊断，均使用该资格检查。后续预览被拒绝时，准备阶段的校验可能已经提交。普通已获准变更保留所属服务的结果。

## 迁移

1. 自定义账号适配器必须让 `getById()` 返回当前生效资格，包含组织和成员状态，并对已删除或缺失账号返回 null。缓存的 HTTP 身份不足以实现它。
2. 自定义 Runtime 管理组装需要传入请求持有的 `AdministratorResponse`；标准 Admin 路由会自动完成。处理器结束前需要等待其发送完成。经 POST 传输的诊断显式选择 `readJson()`。
3. 客户端将403视为失去当前管理员访问权，将503视为授权暂不可用。不需要数据库迁移。参见[发送决策](../../../../.agents/notes/implemented/bug-fix/2026-11-05-administrator-read-publication.zh.md)。
