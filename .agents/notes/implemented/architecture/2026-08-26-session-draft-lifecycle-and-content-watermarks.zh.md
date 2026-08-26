# Agent Note: Deferred session drafts and authoritative content watermarks

Status: implemented

[English](2026-08-26-session-draft-lifecycle-and-content-watermarks.md) | 中文

## Problem

浏览器在首条提示词前创建会话时，策略、轮次和被拒输入事件会写入一个可能永远没有可见内容的对话。多个标签页也可能为同一份未发送草稿生成不同身份，而冷列表没有便宜且权威的方式区分空持久日志与过期 projection 提示。

## Decision

`SessionHeader.draft` 标记浏览器创建且延迟物理持久化的根会话。`PersistenceCoordinator` 将非实体化事件保留在内存中，并在首个非空 surface 消息到达时以原子方式写入缓冲前缀。命令、goal 和 plan 状态事件会实体化为隐藏的 command-only 记录；未实体化草稿在 dispose 时丢弃缓冲。可见消息会把已存储 header 提升为正式会话。附加摘要、projection 和持久化元数据都只使用共享的 `hasConversationContent` 判定空白。

Gateway runtime 在创建 Agent 前预留按 scope 限定的 `(draftId, sessionId)`。PostgreSQL 为重试返回 canonical Session id，续期一小时 lease，并在实体化或草稿成功 dispose 后释放。reservation 不包含 prompt 文本、附件字节或凭据。本地 JSONL 与 SQLite 使用同一套延迟 coordinator，并持久化已提升的草稿标记；SQLite 在预发布无迁移策略下拒绝旧 schema。

Gateway 会话行在同一 append 事务中维护 `has_visible_content`、`visible_content_seq` 和 `last_prompt_at`。`listSnapshots()` 将这些事实提供给冷消费者；有 Gateway 索引时，冷列表不再为了判定空白而解析大日志。迁移回填会对含转义 NUL 的历史事件 JSON 采用保守归类，不对该值使用 PostgreSQL JSON 运算符。已有空根会话可以进入仅管理员可见的 dry-run，并通过现有保留窗口进入可恢复的 empty-draft 回收站。

## Alternatives considered

**持久化每个新 Session，再由 Client 隐藏。** 否决：数据库、归档索引和 workspace 成员关系仍会累积被放弃的根会话，并且多个标签页仍然互相独立。

**以首个受理 prompt 或 `running` 状态作为实体化点。** 否决：pre-step 策略可能拒绝输入或将其改写为空轮次；非空的持久 surface 事件才是所有消费者都能观察到的共享证据。

**把 projection-cache 的 blank 提示作为冷权威。** 否决：checkpoint 可能滞后或缺失。Gateway 水位在 append 事务中更新；本地后端保留有界探测回退。

**第一次清理扫描直接删除旧空行。** 否决：运维需要可审查的 dry-run 和可逆恢复窗口。空草稿使用归档生命周期的维护专用 record kind。

## Consequences

被放弃的浏览器草稿不会留下持久会话工件；同一草稿身份可以跨刷新恢复而不保存凭据。仅命令状态仍可恢复，但不会进入普通对话列表。真实消息到达后，会话直接变为可见，不需要第二次 attach 或身份迁移。Gateway 索引存在时，冷列表成本与会话元数据数量相关，而不是与日志字节数相关。

`SessionHeader` 与 SQLite 元数据格式在预发布阶段发生变化；旧 SQLite 存储被拒绝而不迁移。本地 JSONL 无法更新已经写入的 header，因此提升发生在第一次实体化时，已有工件仍采用保守探测行为。empty-draft 维护仅限管理员，并在配置的 purge 窗口前保留在回收站中。

## Verification

聚焦测试覆盖共享判定器、仅种子草稿缓冲、首条消息原子实体化、command-only 隐藏、陈旧列表对账、Workspace 草稿复用、SQLite schema 所有权、Gateway 内容元数据解析和历史转义 NUL 事件的迁移回填。Gateway 与管理员维护路径验证 scope 所有权、lease 过期、dry-run 选择、回收站、恢复和 purge，且不暴露 prompt 数据。

## Related

- [Session list hides empty turns and resists stale archive snapshots](../bug-fix/2026-08-25-session-list-empty-content-and-archive-ordering.zh.md) — 负责共享可见内容判定和 Client 列表对账。
- [Record last activity in the session index](../../proposed/architecture/2026-07-29-durable-last-activity-index.zh.md) — JSONL 排序仍部分处于提案状态；Gateway 水位实现其中的权威索引部分。
