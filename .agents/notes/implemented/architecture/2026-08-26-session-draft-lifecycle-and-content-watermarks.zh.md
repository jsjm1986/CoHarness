# Agent Note: Deferred session drafts and authoritative content watermarks

Status: implemented

[English](2026-08-26-session-draft-lifecycle-and-content-watermarks.md) | 中文

## Problem

浏览器在首条提示词前创建会话时，策略、轮次和被拒输入事件会写入一个可能永远没有可见内容的对话。多个标签页也可能为同一份未发送草稿生成不同身份，而冷列表没有便宜且权威的方式区分空持久日志与过期 projection 提示。

## Decision

`SessionHeader.draft` 标记浏览器创建且允许延迟持久化的根会话。`PersistenceCoordinator` 在内存中缓冲事件，首次收到非空 surface 消息、带回执的入队事件或命令、目标、计划状态时，以原子方式写入缓冲前缀。输入仍在队列中时，Host 即可确认落盘。未实体化草稿在释放时丢弃缓冲。附加摘要、投影和持久化元数据使用共享的 `hasConversationContent` 判定空白。

Gateway runtime 在创建 Agent 前预留按 scope 限定的 `(draftId, sessionId)`。PostgreSQL 为重试返回 canonical Session id，续期一小时 lease，并在实体化或草稿成功 dispose 后释放。reservation 不包含 prompt 文本、附件字节或凭据。本地 JSONL 与 SQLite 使用同一套延迟 coordinator，并持久化已提升的草稿标记；SQLite 在预发布无迁移策略下拒绝旧 schema。 首次预留尝试在读取租约行前，获取按组织、Runtime、scope 和草稿 id 区分的事务级锁。即使候选 Session id 不同且尚未物化任何 Session，重叠调用仍复用先提交的 Session id。

Gateway 会话行在同一 append 事务中维护 `has_visible_content`、`visible_content_seq` 和 `last_prompt_at`。`listSnapshots()` 将这些事实提供给冷消费者；有 Gateway 索引时，冷列表不再为了判定空白而解析大日志。迁移回填会对含转义 NUL 的历史事件 JSON 采用保守归类，不对该值使用 PostgreSQL JSON 运算符。已有空根会话可以进入仅管理员可见的 dry-run，并通过现有保留窗口进入可恢复的 empty-draft 回收站。

JSONL 在物理 header 读取器和格式 catalog 元数据适配器中都保留可选布尔字段 `draft`。冷读取收到与写入端接纳时相同的生命周期标记；丢弃该标记不能替代可见内容判断。[V5 后继](../bug-fix/2026-09-22-v5-draft-header-successor.zh.md)确认物理 header 修正，不改变已提交 generation 的字节。未知 header 键和非布尔 draft 值仍然无效。

Runtime 归属和维护选择遵循[会话身份决策](2026-10-30-postgres-session-runtime-namespace.zh.md)。

## Alternatives considered

**持久化每个新 Session，再由 Client 隐藏。** 否决：数据库、归档索引和 workspace 成员关系仍会累积被放弃的根会话，并且多个标签页仍然互相独立。

**把已受理的输入或 `running` 状态计为可见内容。** 步骤前策略可以拒绝输入或将其改写为空轮次。各消费者以已持久化的非空 surface 消息判定可见性。

**把 projection-cache 的 blank 提示作为冷权威。** 否决：checkpoint 可能滞后或缺失。Gateway 水位在 append 事务中更新；本地后端保留有界探测回退。

**第一次清理扫描直接删除旧空行。** 否决：运维需要可审查的 dry-run 和可逆恢复窗口。空草稿使用归档生命周期的维护专用 record kind。

## Consequences

未实体化且被放弃的浏览器草稿不留下持久会话记录。同一草稿身份可跨刷新恢复，不保存凭据。只有命令状态或排队输入的会话可以恢复，仍留在普通对话列表之外。可见消息到达后，原会话直接变为可见。Gateway 索引可用时，冷列表读取会话元数据。

`SessionHeader` 与 SQLite 元数据格式在预发布阶段发生变化；旧 SQLite 存储被拒绝而不迁移。本地 JSONL 保留原始物理头部。如果首次实体化后才出现可见消息，读取方根据已提交的正文判定可见性。空草稿维护仅限管理员，删除后保留在回收站直到配置的清理期限届满。

## Verification

聚焦测试覆盖共享判定器、仅种子草稿缓冲、回执与首条消息的原子实体化、仅命令状态的隐藏、陈旧列表对账、工作区草稿复用、SQLite schema 所有权、Gateway 内容元数据解析和历史转义 NUL 事件的迁移回填。无 Key 项目流程验证可见内容到达前能读回已提交回执，同批次重试只保留一次入队。Gateway 与管理员维护路径验证 scope 所有权、lease 过期、dry-run 选择、回收站、恢复和 purge，且不暴露 prompt 数据。

## Related

- [Session list hides empty turns and resists stale archive snapshots](../bug-fix/2026-08-25-session-list-empty-content-and-archive-ordering.zh.md) — 负责共享可见内容判定和 Client 列表对账。
- [Record last activity in the session index](../../proposed/architecture/2026-07-29-durable-last-activity-index.zh.md) — JSONL 排序仍部分处于提案状态；Gateway 水位实现其中的权威索引部分。
