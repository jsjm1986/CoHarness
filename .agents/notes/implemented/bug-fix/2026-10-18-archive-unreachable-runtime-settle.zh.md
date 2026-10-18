# Agent Note：Admin 归档可对运行时无法确认的记录强制收尾

状态：已实现

[English](2026-10-18-archive-unreachable-runtime-settle.md) | 中文

## 问题

归档生命周期命令（`restore`、`trash`、`purge`）是只能由所属运行时消费的持久队列行：运行时轮询 `/internal/runtime/archive/pending`、推送快照、回放返回的命令并回执。所属运行时不再启动时——生产上观察到的是已停止的项目运行时——命令永远 pending。Admin 记录随之无限期停留在 `sync_state='pending'`，`setState` 以 `archive-purge-pending` 拒绝，`purge` 遇到既有 pending 行则提前返回，管理员没有任何手段收尾该记录。另一方面，空白草稿维护以 `record_kind='empty-draft'` 写入 `trash` 状态的记录，但记录列表始终按 `recordKind='conversation'` 查询，且 `message_count > 0` 条件也会隐藏零消息行，已回收的空白草稿在任何归档视图下都不可见。

## 决定

`ConversationArchiveService.settle` 收尾命令已无法送达所属运行时的记录。待清理命令会对 Gateway 存储的数据立即执行 `purgeStoredTree`，该命令标记为已应用，记录变为 `purged`/`synced`；待恢复或回收站命令以未确认说明退役为 `failed`，记录显示 `conflict`，让分歧保持可见。该动作以 `settle` 归档动作暴露，审计为 `admin.archives.settle`。

运行时若日后再上报已清理的根会话，`syncSnapshot` 会重新排入一条清理命令，返回较晚的运行时仍能移除其存留的本地副本，而不是持有一个 Gateway 已不可见的孤儿归档。

管理员列表现在按 `recordKind='all'` 查询，零消息排除只作用于 `record_kind='conversation'` 的行，空白草稿记录在 `trash` 与 `all` 视图下以专属徽标可见。

## 备选方案

**pending 命令自动超时。** 否决：离线数日仍属合法的运行时应当保留其队列，自动截止会静默改变生命周期语义；强制完成让超时裁量保持为显式且经审计的管理员选择。

**把所有 pending 动作直接置为 `synced`。** 否决：把未应用的恢复或回收站标为已应用，等于声称 Gateway 从未验证过的运行时状态；`conflict` 让残留分歧保持诚实。

**为投递命令而启动运行时。** 本变更否决：仅为应用归档簿记而拉起已停止的运行时，会把 Admin 维护与运行时生命周期及其启动副作用耦合。

## 影响

管理员可以从超时行、详情弹窗或批量操作栏收尾永久卡住的归档记录；超过 24 小时的 pending 提示和强制完成确认弹窗会说明两侧数据将发生的变化。强制完成的清理不会删除运行时本地副本——它们由重排的清理命令在运行时下一次快照时移除；永远不再返回的运行时会保留其残留，但该记录已不再跟踪它。
