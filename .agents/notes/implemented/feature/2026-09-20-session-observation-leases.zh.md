# Agent Note: Session 观察租约

Status: implemented

[English](2026-09-20-session-observation-leases.md) | 中文

## 问题

诸如 headless `--session-id` 收养路径之类的消费方需要对某个 Session 做一次点观察——其 header、事件前缀、恢复用游标与已挂载投影的快照——既不强制该 Session 转为实时，也不在每次调用时重读持久化日志。既有语料库读取每次调用都克隆一份完整脱离存储的日志，这对一次性应答是正确的，但对反复观察未变化的持久化 Session 是浪费，而且不提供能让投影与同一观察切点保持一致的留存句柄。

## 决策

`ctx.sessionQuery.observeSession(sessionId, signal?)` 返回留存的 `SessionObservation` 租约（`src/observation.ts`）。实时观察把切点固定在当前日志长度，并在首次读取时物化 `events`；由于日志只追加，迟到的首次读取仍恰好产生该前缀。冷路径先 stat 已存储的 Session，再查询以持久化实例和 `stat` revision 为键的有界 prepared-Session 缓存：revision 未变时复用已恢复但未发布的 Session 而不重读日志，revision 变化或持久化实例更换时经句柄通道重新加载。缓存保留 `preparedSessionCacheSize` 个条目并按最近最少使用逐出，活跃租约会钉住其条目，读取中途转为实时的会话会重走实时路径。`cold-read.ts` 提供基于句柄的冷日志读取；写入方在轮次中途崩溃的日志用 `interruptedTurnClosers` 在内存中补齐，读取绝不改动持久化。`ctx.sessionProjection` 的 `hydrate` 与投影缓存的 `hydratePrepared` 在不把 Session 放入实时存储的前提下，把已挂载投影的快照附加到观察上。

## 考虑过的替代方案

**每次观察复用 `readSession`。** 否决，因为每次调用都会重读并重校验完整日志，且无法在对未变化记录的反复观察之间共享 prepared Session 或投影快照。

**把 Session 放入实时存储以共享其投影。** 否决，因为观察不得把持久化记录变成实时 Session；租约让已恢复的 Session 保持未发布，同时仍提供投影一致的视图。

## 后果

headless 会话收养与后续观察消费方能读到附加了投影快照的一致切点，对未变化 Session 的重复冷观察只需一次 `stat` 调用。缓存引入一个配置项（`preparedSessionCacheSize`），并要求调用方释放返回的租约。

## 测试

`packages/session-query/session-query/tests/observation.spec.ts` 覆盖实时与冷观察、精确 header 与 `inheritedEventCount`、取消、投影快照、跨 revision 与实例的缓存复用、租约钉住，以及内存中的中断轮次补齐。
