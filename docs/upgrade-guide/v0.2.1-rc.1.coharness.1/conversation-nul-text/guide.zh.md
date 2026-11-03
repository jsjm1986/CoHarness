---
kind: upgrade-guide
description: "通过迁移100与版本化查询投影，对话搜索和进展保留 NUL 文本。"
---

# 升级无损对话文本

[English](guide.md) | 中文

## 变更

PostgreSQL 迁移100为活动及归档搜索索引增加无损 NUL 表示，并添加事件查询派生字段。消息追加、历史预览、字面搜索、共享活动和进展接受 NUL，同时保持原始事件不变。进展请求、请求 Session 和摘要内容使用原生 json。HTTP 响应字段和已发布 Session 格式保持不变。

## 迁移

1. 停止所有共享数据库的 Gateway，并保留已通过恢复检查的备份。一并部署配套 Gateway 代码和迁移文件。启动或 `pnpm --dir gateway run pg:migrate` 会在同一事务中执行 SQL 与第一版 JavaScript 回填；单独执行 SQL 文件不能完成迁移。旧写入器无法提供必需的查询字段，不可连接升级后的数据库或降级使用。
2. 等待迁移完成回填和校验后释放独占表锁。批次失败会回滚版本100，可使用相同制品重试。原始事件字节、旧 Runtime 分配、迁移前代和普通搜索值保持保留。
3. 自定义 SQL 索引读取器通过 `harness.conversation_search_text(content,content_nul_parts)` 重建原文，可选传入以码点计的预览长度。对于含 NUL 的行，单独的 `content` 是 trigram 缓存。自定义事件写入器使用版本化查询投影；投影变化需要前向数据迁移。直接读取进展 JSON，不要把整行或请求 Session 转为 jsonb。
4. 通过追加与回读验证含 NUL 的用户、助手和工具消息。分别搜索实际 NUL 与不同的字面转义。确认成员活动、问题上下文、摘要引用和已存请求 Session 保留原文，用量仍属于拥有节点，重复扫描不增加模型调用。参见 [Gateway 参考](../../../../gateway/README.zh.md)与[决策记录](../../../../.agents/notes/implemented/architecture/2026-10-30-conversation-nul-search-and-query-fields.zh.md)。
