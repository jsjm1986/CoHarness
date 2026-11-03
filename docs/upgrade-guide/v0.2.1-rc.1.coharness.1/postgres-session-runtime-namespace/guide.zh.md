---
kind: upgrade-guide
description: "PostgreSQL 会话身份、游标和空白草稿请求需要明确的 Runtime。"
---

# 升级按 Runtime 限定的 PostgreSQL 会话

[English](guide.md) | 中文

## 变更

PostgreSQL 迁移099将全局 Host Session 键替换为组织/Runtime/Host 身份。相同的原始 Host id、追加批次 id 和交互 id 可以在独立 Runtime 中共存。已有归属和事件字节得到保留；无归属历史和缺少 Runtime 证据的预留独立保留为旧数据。新建 Runtime 不能认领它们。

空白草稿预览返回每个候选项的 `runtime.runtimeId`。清理请求以 `sessions: [{ rootSessionId, runtimeId }]` 取代 `ids`，并保留预览的 `cutoff`；`trashed` 返回相同配对。配对缺失、格式错误或重复时返回400。其他电脑的配对不会改变数据。归档记录路由继续使用 `archiveId`。

会话分页和项目活动游标包含 Runtime。旧会话分页游标被拒绝；没有完整身份的活动游标从第一页重新开始。通知载荷包含 `runtimeId`；原生客户端要求该字段，不会在当前选中的 Runtime 中打开同名 Host id。已发布的 JSONL 各代保持不变。

读取项目对话共享信息和修改可见性时携带该 Session 的 `dshRuntime`、`dshTarget` 和 `projectId`。其他标签页切换空间时仍保留这些选择字段，共享的 scope Cookie 不能确定请求所属的 Runtime。

## 迁移

1. 停止共享数据库的全部 Gateway，并保留经过恢复验证的备份。一起升级全部 Gateway 载荷，包括受管电脑。启动时应用迁移099；不要对迁移后的数据库运行旧 SQL 写入方，也不要降级已迁移的数据库。
2. 部署配套 Admin UI 和原生/Web 载荷。自定义维护客户端将每个预览配对保留到确认，并检查返回的配对。升级后清除旧分页状态并刷新页面。缺少 Runtime 的旧通知不会打开会话。
3. 自定义存储消费方根据已认证的分配元数据构造 `PostgresConversationStore.forRuntime({ organizationId, runtimeId })`。协作、推送和维护空间调用携带相同 Runtime，不能根据 Host id 或新分配推断它。
4. 确认两个 Runtime 的同名 Host id 保留独立正文、重试、审批和清理。比较迁移前后的旧事件字节与归属，包括未知记录。确认选中一个同名草稿会保留另一个。参见[Gateway 参考](../../../../gateway/README.zh.md)和[身份决策](../../../../.agents/notes/implemented/architecture/2026-10-30-postgres-session-runtime-namespace.zh.md)。
