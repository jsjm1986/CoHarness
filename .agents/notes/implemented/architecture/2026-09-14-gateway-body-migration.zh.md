# Agent Note：Gateway body 迁移由服务端权威执行

状态：已实现

[English](2026-09-14-gateway-body-migration.md) | 中文

## 问题

以旧 Session format 版本写入 Gateway 的会话在升级后必须既可读又可继续。惰性读时迁移只升级内存视图：存储行仍停留在旧代次，resume 后首个 append 会用迁移后的坐标写入旧序列，被 PostgreSQL 的 `expected seq` 校验拒绝——会话能加载但无法续写。

## 决策

`POST /internal/runtime/session/migrate` 在单个 PostgreSQL 事务内完成迁移。路由认证 runtime token，施加与其他会话读取相同的 `belongsToRuntime` 范围检查，要求目标 header 携带 catalog 当前版本，并在到达 repository 前剥离按调用方限定的 revision 前缀。

`ConversationRepository.migrate` 按 append 相同的顺序先锁 root 再锁会话，校验调用方的 `version:next_seq` 源 revision，读取完整存储事件体，并运行传入的 transform——与 coordinator 读时迁移所用的同一条 `sessionFormatCatalog` 流，因此提交的后继与读方惰性看到的完全一致。存储版本高于目标、源 revision 过期、transform 产出不连续或版本不符都会拒绝；在重写前先写入以 `UNIQUE(session_id, migration_id)` 为键的 `conversation_migrations` 回执。已提交的前代事件行按回执 id 复制进 `conversation_migrated_events`，与文件后端的代次保留规则一致；随后 `conversation_events` 与 `conversation_search` 被重写，会话行的计数器、可见内容字段、seed 长度与格式版本在同一次提交中重算；子会话迁移会重算 root 镜像。提交的 `seedLength` 取迁移流的 `finish()` 结果——目标代次的切点——而非源 header 的 `seedLength`；当生成事件延展了继承区间时，带种子的 v3 前日志可以合法地移动该值。并发迁移在会话锁上串行化：后到者持相同 migration id 时读到 `current`，源 revision 过期则响亮失败。

Gateway 持久化 adapter 声明 `supportsBodyMigration`，wire 上只发送标识、源 revision、目标 header 与确定性 migration id——绝不发送迁移后的事件体——因此服务端对存储字节保持权威，大会话也不受请求体上限约束。adapter 将响应中的 `nextSeq`/`seedLength` 与本地迁移视图比对，不一致即报 protocol 错误，使两条 release 线之间的 catalog 偏斜表现为响亮失败而不是静默分裂游标。旧版 Gateway 缺少该路由时是兼容性 no-op。

## 考虑过的替代方案

**客户端推送迁移后的事件体。** 拒绝：请求体上限会在大会话上断裂，且服务端将不得不信任客户端算出的字节而非自身 catalog 的输出。

**以旧坐标持久化迁移结果。** 拒绝：迁移会重排事件序号，在旧序列下写入当前代次事件会留下 append 校验随后拒绝的混合代次 artifact。

**给 `conversation_events` 加 generation 列。** 拒绝：它会让每条读取和 append 查询变复杂；独立的保全表提供相同的代次保留保证而不触碰热路径。

## 结果

旧会话在升级后可加载、可续写，前代在会话删除前始终可恢复，部署不一致会在 adapter 校验处响亮失败而不是损坏存储行。代价是一对额外表，以及独立 Gateway 构建必须链接的服务端 catalog 依赖。

## 验证

`gateway/tests/runtime-api.spec.ts` 覆盖路由认证、ACL、revision 前缀剥离、目标版本拒绝与 catalog transform 集成。`gateway/tests/postgres.spec.ts` 覆盖事务重写、保全行、幂等 `current` 结果、过期 revision 与序列空洞拒绝、root 镜像重算，以及在迁移游标上的 append 续写。
