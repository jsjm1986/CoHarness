# Agent Note：冷会话历史读取不再被「打开即 resume」的并发写入打断

状态：已实现

[English](2026-09-03-history-read-survives-concurrent-resume.md) | 中文

## 问题

在 Web 客户端打开一个较大的冷会话时，只要尾页装不进一个持久化分页，界面就报「Failed to load history: history storage is temporarily unavailable」。客户端同时发出 `session.history` 与对同一会话的 resume；resume 会追加生命周期事件（`session/end-seed`、`permission/preset`、`sandbox/mode`、`approval/policy`），在 Host 的[有界冷读分页游走](../architecture/2026-08-31-bounded-detached-history-pages.zh.md)尚未结束时改变了持久化 revision。游走要么在单页读取内部观察到变化（`dependency`），要么通过绑定在续页 cursor 里的 revision 观察到——而基类 `readPage` 把后者归为调用方的 `protocol` 错误；`historySourceFor` 把两种失败都原样抛给客户端，客户端 `doOpen` 又不重试。小会话一页读完、碰不到这个窗口；`complex-history.perf.ts` lane 以及任何超过约 50 条消息的会话则每次冷打开必现。

## 决策

`historySourceFor` 把分页游走放进 `boundedDetachedHistory()`，捕获 `dependency` 后重新读取 `ctx.sessions.get(sessionId)`：期间已 attach 的会话改由驻留日志提供——这正是 resume 先完成时请求本应走的来源；否则用新 revision 重走一次，再次变化则照旧报错。基类 `SessionPersistence.readPage` 对 cursor 指向其他会话或方向的情况保留 `protocol`，对 revision 不再匹配的 cursor 改判 `dependency`——与它在单页读取中 revision 变化时已使用的可重试类别一致。Gateway 的会话分页读取（`ConversationRepository.readPage` 与 runtime API 的兼容分页）做同样的拆分，这样使用 Gateway 持久化的 Host 收到的是 `GatewaySessionPersistence` 本就映射为 `dependency` 的 503 `conversation-dependency`，而不是它永远不会重试的 400 `protocol`。

## 备选方案

**在客户端 `doOpen` 对 `dependency` 重试一次。** resume 仍在追加时第二次往返可能同样失败，而且客户端无法知道 attached 日志已经存在；Host 侧切换来源不需要额外请求。

**先完成 resume 再允许首次历史读取。** 每次打开都要等整段日志装载完才接纳模型请求，正是[活动会话历史驻留](2026-08-24-live-conversation-history-retention.zh.md)那篇 Note 为 prompt 否决过的代价。

**维持过期 cursor 的 `protocol` 分类。** cursor 绑定 revision 的目的就是让变动的日志使其失效；这个条件是瞬时且与提供者无关的，能从 `dependency` 恢复的调用方必须在该类别下看到它。

## 后果

resume 先赢的冷打开直接从 attached 会话取尾页，不再多一次持久化读取；被其他写入者改动的日志付一次重走的代价。持续变化的 revision 仍按既有安全消息失败关闭。Host 测试覆盖 attached 回退（resume 的 `session/end-seed` 边界出现在返回页里）、单次重走与有界重试；持久化分页测试与两处 Gateway 分页测试钉住「revision 变化 → `dependency`」与「外来 cursor → `protocol`」两种分类。
