# Agent Note: 使用带显式扩展表的 CoHarness SQLite schema 20

Status: implemented

[English](2026-08-29-session-sqlite-schema20.md) | 中文

## Problem

上游 schema 19 修改 SQLite 主键，并复用事件标记表示物理打包。CoHarness 还需要持久化草稿状态和逻辑可忽略事件；只修改 pragma 既不能保留这些语义，也无法提供安全回滚。

## Decision

新的 Session SQLite 文件使用 schema 20。`sessions.id` 是整数存储键，`session_key` 保留外部 SessionId；事件引用整数键并带有非空的 `is_packed` 判别字段。`session_extensions` 保存草稿状态，`event_extensions` 只保存逻辑 `ignorable: true` 标记。运行时拒绝 schema 18，打开时不会隐式升级。显式离线工具导出逻辑事件，使用 schema 自有 codec 重建目标 schema，比较逻辑会话 SHA-256 hash，对结果执行 fsync，并且只有在 `--replace --keep-backup` 下才替换输入。反向工具写出兼容 schema 18 的逻辑文件，供回滚和取证恢复使用。

## Alternatives considered

**只修改 `PRAGMA user_version`。** 不采用，因为表列、键类型、压缩方式和标记语义仍然不兼容。

**把 draft 和 ignorable 保留在上游主表。** 不采用，因为物理打包和逻辑事件准入会再次共享字段，后续 schema 变更可能静默重新解释它。

**在 `openDatabase()` 中自动在线迁移。** 不采用，因为运行中的写入方或失败的复制可能让唯一会话产物处于半转换状态。

## Consequences

存储布局不与上游 schema 19 保持字节兼容，但公共 SessionId、事件流、revision、草稿行为和 ACL 所需元数据保持稳定。运维必须安排离线迁移，并在冷回放成功前保留旧文件。空存储也可迁移，因为 singleton store identity 独立复制，不依赖会话行。

## Testing

SQLite 持久化测试覆盖 schema ownership、整数键连接、打包与逻辑扩展行、陈旧修复、草稿恢复和物理损坏。迁移命令校验双向转换，拒绝同路径或已存在的输出，保留 store identity 与逻辑事件 hash，并在失败时保持输入不变。
