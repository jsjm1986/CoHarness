---
description: "压缩事件负载的 SQLite Session 持久化"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-sqlite

[English](README.md) | 中文

一个可选启用的 SQLite `SessionPersistence` 提供方。它将每个事件存为一行，对较大的负载按需应用 Zstandard 压缩，并紧凑编码来源事件序列，恢复完整一致的逻辑 `SessionEvent[]`。部署方需显式挂载本包并配置数据库路径。

`locate(meta)` 返回 `undefined`，因为所有会话共享同一个数据库。该提供方不暴露逐会话原始产物。`revision(id, signal?)` 读取带索引的会话行，不扫描其他会话元数据或事件行。

## 概述

部署需要在一个 SQLite 数据库中持久保存 Session 日志时，可使用 `dsh-session-persistence-sqlite`。追加会保留既有事件，并将新批次及其修订号一并提交，消费方无需加载历史就能检查 Session 的修订号。

## 目录

- [存储模型](#storage-model)
- [Schema 兼容性](#schema-compatibility)
- [配置（schemastery）](#configuration-schemastery)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="storage-model"></a>
## 存储模型

Schema 21 使用整数内部会话键和稳定的外部 `session_key`。复合主键 `events(session_id, seq)` 定位标量事件行，每行的 `is_packed` 为 0。解码器拒绝打包行。`session_extensions` 保存草稿标记，`event_extensions` 保存逻辑 `ignorable` 标记。

序列化后的 `data` 小于 4 KiB 时保留为 SQLite `TEXT`。达到该阈值后，写入方使用固定字典以 Zstandard 级别 3 压缩，仅在压缩结果比原文本小时存为 `BLOB`。每行可独立解压。带标签的变长整数使用连续区间或差值编码，保留完整且有序的 `source_event_seqs` 数组。

追加使用 `BEGIN IMMEDIATE` 校验 schema 和事件尾部的有限范围，插入新批次，并递增 Session 修订号。尾部校验会在变更数据前拦截过期写入。默认 200 毫秒的写后缓冲间隔会把新事件合成一个批次。

读取按序列号扫描事件。`readFrom(id, fromSeq)` 从指定序号开始，避免解码更早的前缀。已提交前缀受损会导致读取失败。修复可以在持有写锁并重新确认未完成尾部的起始序列号后删除该尾部。

<a id="schema-compatibility"></a>
## Schema 兼容性

SQLite Session 存储会拒绝创建绑定受管 SSH 目标的 Session。此类 Session 使用部署的 JSONL 或 Gateway 持久化。

全新数据库初始化为 schema 21。打开时会拒绝其他应用的标识、非空且没有版本号的文件、其他 SQLite schema 版本或不兼容的 schema 对象。升级 SQLite schema 必须显式离线转换。[Schema 20 转换工具](../../../.agents/notes/implemented/architecture/2026-08-29-session-sqlite-schema20.zh.md) 支持文档所列的 v18 与 v20 互转。

每次写入均在写事务内校验应用标识、版本号和实际的有序 schema 定义。仅空白有差异的等价定义仍兼容。运行时语句和 pragma 位于随包发布的 `.sql` 资源中。

逻辑 Session 格式迁移独立于数据库 schema。提供方按检查时的源修订号验证，在同一事务中发布迁移后的头信息和事件。

<a id="configuration-schemastery"></a>
## 配置（schemastery）

```ts
interface Config {
  path: string
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'
  busyTimeoutMs?: number
  preparedSessionCacheSize?: number
  writeBatchMaxDelayMs?: number
  maxPendingEvents?: number
  maxPendingBytes?: number
}
```

`journalMode` 默认为 `wal`，`busyTimeoutMs` 默认为 `5,000`，`preparedSessionCacheSize` 默认为 `5`，`writeBatchMaxDelayMs` 默认为 `200`，`maxPendingEvents` 默认为 `100,000`，`maxPendingBytes` 默认为 `64 MiB`。该超时限制每次同步 SQLite 锁等待的时长。SQLite 在切换 journal mode 时可能立即返回 `SQLITE_BUSY`，因此冷打开会在尝试之间让出执行，并在从打开时开始计算的重试截止点后不再发起新尝试。正在执行的同步 SQLite 调用可能在该截止点之后才完成。提供方会在每个连接上禁用可信 schema 与内存映射 I/O，然后读回这两项设置。提供方还会读回所选 journal mode 并要求它匹配；内存数据库显式接受 SQLite 返回的 `memory`。选择 journal 后，提供方会把 `synchronous` 固定为 `FULL` 并验证该设置，避免 SQLite 构建默认值削弱已提交追加的持久性。在 POSIX 上，数据库父目录和文件必须归当前用户所有，父目录不得允许组或其他用户写入，文件不得授予组或其他用户任何权限。符号链接和非普通文件会被拒绝。Windows 同样拒绝符号链接与非普通文件，但部署方仍负责把目录和文件 ACL 限制给 harness 用户。路径与所有权错误会拒绝插件初始化。Node SQLite 在第一次持久化操作时才加载；导入时只抑制 Node 22 精确的 SQLite `ExperimentalWarning`。存储身份与 schema 错误会在暴露或变更数据前拒绝该操作。

<a id="model-experience"></a>
## 模型体验

### 恢复的对话历史

#### 模型看到什么

恢复得到与 JSONL 相同的逻辑 `SessionEvent[]` 和派生消息。

#### Token 影响

实时请求增加零 token。恢复只为保留的逻辑历史和当前请求 envelope 付出 token。

#### KV Cache 影响

提供方 cache 复用取决于重建后的历史、当前请求及模型路由。


<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **SQLite 专用设计**——实现参考了 [morlay/session-persistence-rdb](https://github.com/morlay/session-persistence-rdb)。其他关系数据库和可配置 schema 超出本包范围。
- **同步压缩**——Node 的 SQLite 与 Zstandard 调用都会阻塞 JavaScript 线程；4 KiB 阈值限制了小型记录的逐 frame 工作。
- **繁忙等待会阻塞事件循环**——SQLite 会在同步 `DatabaseSync` 调用内等待；只有繁忙的 journal-mode 切换会在两次尝试之间让出执行，而且从打开时计算的截止点只阻止新尝试，不会中断正在执行的调用。
- **追加只做插入**——提供方没有后台历史压缩。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
