# storage/：非会话存储家族

[English](README.md) | 中文

本家族通过具名后端和类型化数据形式，持久化会话事件日志以外的应用数据。

| 包 | 职责 | ctx key |
|---|---|---|
| [`storage/`](storage/README.zh.md) | 将已注册后端与类型化数据形式连接起来 | `ctx.storage` |
| [`storage-json/`](storage-json/README.zh.md) | 在 JSON 文件中存储数据 | 注册后端 `json` |
| [`storage-sqlite/`](storage-sqlite/README.zh.md) | 在 SQLite 中存储数据 | 注册后端 `sqlite` |
| [`storage-domain/`](storage-domain/README.zh.md) | 提供经过验证的领域记录存储 | `ctx.storageDomain` |

消费方使用数据形式，而不是直接访问后端。[领域存储决策](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)记录了该家族的设计。

子系统参考——后端约定、`StorageForms`、`DomainSpec`/`Domain`、`domain/changed`——见 [docs/subsystems/storage.md](../../docs/subsystems/storage.zh.md)。


## 概述

存储组跨重启保留非会话应用数据，包括工作区记录和会话伴随数据。需要人类可读文件时选择 `storage-json`，需要在单个数据库中定点更新时选择 `storage-sqlite`；`storage-domain` 增加经过 schema 校验的类型化记录和变更通知，而 `storage` 选择已配置的后端。这些包是可选项且只面向宿主侧：它们不会向模型暴露工具、提示词内容或会话事件。当应用状态必须在进程结束后继续存在时使用本组；组合没有此类数据时可以省略本组。
