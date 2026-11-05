# Agent Note: PostgreSQL 会话在各 Runtime 内保留 Host 标识

Status: implemented

[English](2026-10-30-postgres-session-runtime-namespace.md) | 中文

## 问题

Host Session 标识属于生成它的 Runtime。数据库全局 Host 键使独立历史争用同一标识。仅添加 Runtime 元数据而保留全局键，无法在标识重合时隔离正文、重试、后代、审批和派生记录。

## 决策

PostgreSQL 使用组织、Runtime 命名空间和原始 Host id 标识会话数据。`PostgresConversationStore.forRuntime()` 根据已认证的 Runtime 坐标构造不可变仓库；整个操作的读取和变更始终使用该仓库。根继承、追加批次、迁移前代、搜索、参与者、交互响应、文件引用、推送投递和进度收据保留相同命名空间。维护空间的审批消耗和活动游标也保留 Runtime。

迁移099保留已有字段和原始事件字节。命名空间来自已记录的归属。无归属历史和缺少 Runtime 证据的草稿预留独立保留为旧记录；新建 Runtime 不能认领它们。新正文写入必须具有已记录的 Runtime，并拒绝改变引用归属。JSONL 各代和原始 Host 标识保持不变。

维护选择把已审核的 Runtime/Host 配对贯穿预览、浏览器选择和确认。通知操作携带生成它的 Runtime。浏览器读取和修改共享范围时保留 Session 的 Runtime 分配身份与项目选择，不依赖其他标签页的 scope Cookie。缺少完整身份时，不能根据同名 Host 选择另一个 Runtime。[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/postgres-session-runtime-namespace/guide.zh.md)负责部署和客户端迁移步骤。

## 考虑过的替代方案

**将所有 Host 标识改写为全局名称。** 拒绝，因为本地日志、引用和不可变前代保留生成方的标识。

**先查找同名会话，再推断 Runtime。** 拒绝，因为同一标识可以同时属于多个有权或无权访问的主体。

**将未知历史分配给新建 Runtime。** 拒绝，因为一次分配无法确定最初保存旧数据的 Runtime，也不能授予访问权限。

## 后果

共享数据库的 Gateway 一起升级。当前客户端刷新旧游标，并提交已审核的维护配对。旧记录只能通过已有的明确历史归属路径访问，不能成为新 Runtime 的回退来源。

[写入锁](../bug-fix/2026-10-24-conversation-writer-locks.zh.md)、[协作](../feature/2026-08-15-project-collaborative-conversations.zh.md)和[草稿生命周期](2026-08-26-session-draft-lifecycle-and-content-watermarks.zh.md)决策继续有效。Runtime 限定补充其权限与持久化规则。迁移字节保留、同名会话的认证 HTTP、并发撤权和独立浏览器选择需要数据库及完整应用验证。逻辑电脑夹具不能证明真实多主机或真实模型服务验收。
