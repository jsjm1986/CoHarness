---
kind: upgrade-guide
description: 管理资源策略与管家目录读取会拒绝请求等待期间已撤销的管理员资格。
---
# 资源读取的管理员授权

[English](guide.md) | 中文

## 变更

桌面、终端、SSH、插件、管家、记忆的权限 GET，以及 `GET /admin/api/steward`，在数据库准入时要求当前活动管理员资格。请求等待期间角色、账号、成员关系或组织资格被撤销时，会返回403 `forbidden`。读取器保留资格后，并发撤销会等待其读取事务完成。权限值与修订号保持不变。

## 迁移

1. 客户端必须处理在途管理读取的403响应，并在资格撤销后停止展示其结果。
2. 自定义 Admin 服务调用方把已认证账号 id 作为第二个参数传给 `ResourceAccess.get(owner, actorUserId)`，或作为第一个参数传给 `StewardAccess.list(actorUserId)`。省略操作者仍只供可信内部读取。浏览器操作者字段不授予权限。
3. 不需要数据库或配置迁移。确认当前管理员可以读取，且撤销提交后排队请求被拒绝。参见[读取决策](../../../../.agents/notes/implemented/bug-fix/2026-11-05-resource-policy-read-authority.zh.md)。
