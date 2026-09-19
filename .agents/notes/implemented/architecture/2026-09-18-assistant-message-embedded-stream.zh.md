# Agent Note: 助手消息内嵌其提供方流

Status: implemented

[English](2026-09-18-assistant-message-embedded-stream.md) | 中文

## 问题

`assistant/message` 事件通过 `sourceEventSeqs` 引用产生它们的 `assistant/chunk` 序号，因此每个已结算助手消息的消费方——令牌计量、历史分页、后缀窗口——都要经由日志解析一层间接引用。该引用还让 `assistant/message` 有资格充当替换节点，尽管引用被遮蔽 surface 节点的替换在助手事件上并无有效用途，而且它复制了消息本可直接携带的溯源信息。

## 决策

采用上游契约：`assistant/message` 在 `data.stream` 中内嵌其提供方流（由 `AssistantStreamAccumulator` 产生的 `AssistantStreamRecord[]`），且不得携带 `sourceEventSeqs`。`SurfaceIntent<T extends SurfaceEventType>` 对 `assistant/message` 将该字段标记为 `never`，对 `system/message`、`user/message`、`tool/result` 保留；`Session.append` 与存储日志校验拒绝 `assistant/message` 上的该字段。`surfaceOp` 在每个 surface 事件上为必填。`expandAssistantStream` 为断言与诊断重建带时序的 chunk 序列。

消费方改变的是形态而非语义：

- 令牌计量与用量投影读取内嵌流与用量记录，不再解析被引用的 chunk 事件；缺少 `data.stream` 的遗留迁移事件保留耐用回退。
- 历史详情与 wire 分页从紧邻消息之前的同 step 连续 `assistant/chunk` 段推导 append 来源消息组，仅为本契约生效前持久化的日志保留 `sourceEventSeqs` 回退。
- 替换意图迁移至 `user/message`：压缩摘要与其他用户可见的替换通过 `user/message`、`system/message` 或 `tool/result` 替换事件引用被遮蔽节点。

`assistant/chunk` 事件随后由 [chunk 移除决定](2026-09-19-assistant-chunk-event-removal.zh.md)从 `SessionEventMap` 整体移除：`data.stream` 在格式 v4 为必填，按先前契约写入的持久化事件可能仍携带 `sourceEventSeqs`；读取方保留回退，因为已存储的代次不可变。

## 备选方案

在内嵌流之外保留引用会复制溯源信息并保留无效的替换形态。在同一变更中移除 `assistant/chunk` 会把本次契约迁移与更大规模的结算及格式拆分工作耦合。读取时剥离 `sourceEventSeqs` 会改写不可变的已存储代次。

## 影响

`assistant/message` 不再能充当替换节点，替换生产者与夹具改用 `user/message`。测试与已提交的 JSONL 夹具就地迁移：原先走引用路径的夹具改为内嵌流，兼容夹具通过 `as unknown as SessionEvent` 保留 `sourceEventSeqs` 以覆盖持久化遗留回退。TypeScript 与 Python SDK 投影不受影响，因为 `sourceEventSeqs` 从未出现在 wire 上。
