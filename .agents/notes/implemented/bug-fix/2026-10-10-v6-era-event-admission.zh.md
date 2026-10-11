# Agent Note: V6 时代事件类型被自己的迁移拒绝

Status: implemented

[English](2026-10-10-v6-era-event-admission.md) | 中文

## 问题

`sessionFormatV6ToV7` 用 `RELEASED_V6_EVENT_TYPES` 校验每一个被迁移的源事件——那是 V6 发布时冻结的事件语汇(`extension-identities.ts` 中的 PR-232 快照)。`gateway/scoped-execution` 与 `gateway/continuation` 是在 V6 时代加入 `SessionEventMap` 的——事件表新增不属于结构变更,因此 V6 写入器合法地把它们追加进 V6 日志——但冻结表早于它们。任何携带这两种标记的 V6 日志都以 `format v6 contains unknown event type` 迁移失败,经 `generationFailure` 转为 `SessionFormatUnsupportedError`,到 RPC 层变成 `history unavailable for session "…"`:尽管当前构建认识日志里每一种类型,会话仍永久不可读。`historicalSessionFormatCatalog` 的 V6 恢复用的也是同一冻结表,所以父日志带 scope 标记的 seeded 子会话会同样失败。生产环境已有三个这样的日志。

## 决策

V6 准入问的是"V6 写入器能否产出它",而不是"冻结的已发布语汇认不认识它"。`ADMITTED_V6_EVENT_TYPES` = `RELEASED_V6_EVENT_TYPES` 加两个 V6 时代新增;迁移阶段与 `namespaceV6OpaqueEvent` 使用它,`historicalSessionFormatCatalog` 也按它恢复 V6 工件。`developer/message` 保持 foreign:它是 V7 原生类型,V6 写入器不可能产出,V6 日志中 ignorable 的它正确地以 `plugin:developer/message` 命名空间化为不透明数据。真正外来的必需类型仍被拒绝。冻结的已发表本身不变——已发布的 V6 阅读器仍必须拒绝它无法解释的 scope 标记,而不是把缩窄的执行静默当作累积权限。另外,`session.history` 现在把 `SessionPersistenceNotFoundError` 映射为 `session-not-found`,把 `SessionFormatUnsupportedError`/`SessionPersistenceCorruptionError` 映射为分类明确的 `internal` 消息,而不是落入兜底;原始日志路径只留在 warn 日志。

## 备选方案

**在 V6 边界直接接纳当前安装的 `KNOWN_SESSION_EVENT_TYPES`。** 否决:`KNOWN` 含 `developer/message`——V6 写入器不可能产出的类型;V6 日志中 ignorable 的它会被按 V7 语义解释而不是保持不透明,这正是 catalog 测试钉死的历史恢复契约。

**保留冻结表作为迁移语汇。** 否决:它会让 harness 自己写出的日志永久孤儿化;拒绝机制的本意是挡住缺少相应语义解释器,而执行迁移的构建拥有这些语义。

## 后果

携带 `gateway/scoped-execution` 或 `gateway/continuation` 的 V6 日志正常迁移并可读;事件保留类型与坐标进入 V7。声称含 `developer/message` 或任何臆造必需类型的 V6 日志仍以 `format v6 contains unknown event type` 失败。写路径与读路径一并解封,因为两者都走 `requireStoredLog`。`session.history` 的公开错误词表不变(`session-not-found`、`internal`);只是持久化层失败的分类得到改善,含原始路径的后端诊断仍留在服务端。

## 验证

`logical-dialect.spec` 迁移携带两种 gateway 类型的 V6 工件,断言它们保留类型、`developer/message` ignorable 命名空间化为 `plugin:`、臆造类型仍被拒。`v6-gateway-events.spec` 经 JSONL 持久化打开真实 V6 工件:读得到带类型事件且源字节不变,写发布含该标记的 V7 代际,外来类型日志仍抛 `SessionFormatUnsupportedError`。`catalog.spec` 经 `historicalSessionFormatCatalog` 恢复这两种 gateway 类型。`api-proxy-cold.spec` 验证持久化 not-found 映射 `session-not-found`、format-unsupported 与 corruption 失败映射分类消息,并断言原始日志路径绝不进入客户端消息。生产环境的六个 V6 会话(含三个携带 `gateway/scoped-execution` 的)全部经真实后端打开成功。
