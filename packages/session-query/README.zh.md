# session-query/：会话检索能力家族

[English](README.md) | 中文

本家族提供经过授权的实时与持久会话日志检索，且独立于压缩（compaction）。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`session-query/`](session-query/README.zh.md) | 定义可信读取、关系查询和搜索操作 | `ctx.sessionQuery` |
| [`session-query-sqlite/`](session-query-sqlite/README.zh.md) | 使用 SQLite 全文搜索实现会话查询 | `ctx.sessionQuery` |
| [`session-log-export/`](session-log-export/README.zh.md) | 在 Host ZIP 端点之上增加 Web `/export` 命令、共享浏览器下载状态和结果弹窗 | `ctx.sessionLogDownload` |
| [`tool-session-query/`](tool-session-query/README.zh.md) | 向模型公开经过工作区授权的会话查询 | 注册到 `ctx.tools` |

子系统参考——逻辑记录、有界读取、追踪、筛选器、结果页——见 [docs/subsystems/session-query.md](../../docs/subsystems/session-query.zh.md)。


## 概述

`session-query/` 组提供对实时与持久会话历史的检索，且独立于压缩（compaction）：程序化调用方通过一个统一服务查询精确日志、过滤后的列表、关系追踪与全文搜索；SQLite 后端支撑搜索；模型获得五个经工作区授权的工具；Web 界面获得下载会话 ZIP 的 `/export` 命令。搜索结果与模型看到的对话历史一致。本页概述该组；各包的 README 分别说明各自的包级约定。
