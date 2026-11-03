# Agent Note：无损对话文本与事件查询字段

状态：已实施

[English](2026-10-30-conversation-nul-search-and-query-fields.md) | 中文

## 问题

Session JSON 可以包含 NUL，而 PostgreSQL text 和 jsonb 不能。搜索插入与追加共用事务，因此索引中的不支持字符会回滚原始正文。排除整条含 NUL 事件的保护条件，还会移除原本有效的成员活动、问题关联和进展材料。

## 决策

迁移100保持普通搜索文本不变。含 NUL 的行保存以原始 NUL 分隔的各段，以及以换行连接的 trigram 缓存。字面模式匹配连续原始分段，包括空段；模糊候选使用缓存。字面匹配继续优先。原生 json 结果标量重建原文和有界预览，无需把 NUL 解码为 PostgreSQL text。活动与归档索引使用相同表示。

[第一版投影](../../../../gateway/src/postgres/conversation-query-fields-v1.ts)在 JavaScript 中提取轮次编号、数字参与者身份、显示名称、工具调用 ID 和问题参数。自由文本标量经过 JSON 编码后保存在 jsonb 字段中，并通过原生 json 返回，因此 PostgreSQL 不导航含 NUL 的正文。含 NUL 的调用 ID 无法命名 PostgreSQL 交互响应，不生成关联字段。原始事件 JSON、序号、负载长度和 Runtime 分配保持不变。

迁移运行器在记录版本100之前，于同一事务中执行模式变更和有界 JavaScript 回填。更新派生字段时会暂停并恢复现有的 Runtime 必填写入检查，独占表锁保护旧的未分配行。失败会同时回滚模式和派生记录。后续投影变更使用新版本及前向迁移。

进展请求输入、请求 Session 和摘要内容使用原生 json。请求 Session 身份检查读取经过 NUL 归一化的结构视图；已存制品保留原始值。不可变制品触发器比较原始 JSON 字节并拒绝替换。完整模型输入仍可从记录的 Session 重建。

## 考虑过的替代方案

**替换原始索引值中的 NUL。** 否决，因为换行、替换字符和字面转义具有不同的搜索语义。

**省略受影响的索引或事件。** 否决，因为已接收消息仍须可搜索，并能进入共享活动和进展。

**以 jsonb 导航原始事件。** 否决，因为转换会拒绝同样有效的 NUL 值。

## 结果

共享数据库的 Gateway 使用配套运行器和模式。SQL 消费者通过重建辅助函数读取原始索引值，不能把 trigram 缓存当作原文。[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/conversation-nul-text/guide.zh.md)负责部署步骤。[字面搜索决策](../bug-fix/2026-10-25-gateway-literal-conversation-search.zh.md)与 [Runtime 身份决策](2026-10-30-postgres-session-runtime-namespace.zh.md)继续有效。

## 验证

真实 PostgreSQL 检查覆盖全部索引角色、字面 NUL 分界、通配符转义、Unicode 预览、代际保留、旧字节、第二批失败回滚和未分配写入拒绝。可运行的 Gateway HTTP 与双电脑摘要转录覆盖原始正文、活动、问题关联、请求 Session、引用、用量归属和重放。
