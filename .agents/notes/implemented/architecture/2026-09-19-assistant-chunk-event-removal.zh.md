# Agent Note: 移除 `assistant/chunk` 会话事件

Status: implemented

[English](2026-09-19-assistant-chunk-event-removal.md) | 中文

## Problem

`assistant/chunk` 事件把每个流式增量都变成持久 `SessionEvent`：token 粒度的行占满保留字节，`sourceEventSeqs` 引用把每条已结算消息连回它的 chunk 序列，每个消费方——计量、分页、投影、UI——都要解析这层间接。[embedded-stream 决定](2026-09-18-assistant-message-embedded-stream.zh.md)已把结算来源引用搬进 `assistant/message.data.stream`；剩下的是 chunk 事件本身，以及两个后端在其上构建的物理行打包。

## Decision

Session 格式 v4 从 `SessionEventMap` 移除 `assistant/chunk`。一次成功的 provider 调用持久化为一条 `assistant/message`，携带 `message` 与紧凑的 `stream: AssistantStreamRecord[]`；一个失败、重试、取消或流错误且结算时未产生表面消息的尝试持久化为 `assistant/attempt`，携带同样的 stream 字段。`expandAssistantStream` 为需要时序 chunk 的消费方重建它们。

实时输出走 `agent/assistant-stream` 帧（`start`/`chunk`/`end`，携带尝试身份、revision、稠密序号与持久游标），以 `session/assistant-stream` 传输给宿主客户端；宿主重连累加器把每个尝试对其持久游标取基线。Web 客户端把帧折叠成瞬态 `assistant/live-chunk` 行，并与持久 `assistant/message`/`assistant/attempt` 事件结算，因此持久主脉保持纯 `SessionEvent`。

已发布各代保持可读：格式目录新增 v3→v4 阶段，把每个连续的同步 step `assistant/chunk` 序列折叠进结算事件的内嵌流，对没有 message 的孤儿序列合成 `assistant/attempt`。已提交的 v0–v3 文件绝不重写；夹具门禁对前代文件保持逐字节原样，只对当前代或未版本化文件做规范化。JSONL 每行写一个逻辑事件，仅解码 v3 打包存储行。SQLite schema 21 每行写一个事件，打包物理行仍可解码，且 `scripts/session-sqlite-migration.ts` 独占 v18↔v20 打包行编码——core 不保留编码器，退役词汇无法回流运行时写路径。

## Alternatives considered

**保留 `assistant/chunk` 与内嵌流并存。** 同一份流落在两套词汇里，保留了内嵌流已经取代的 `sourceEventSeqs` 间接层，并让每个消费方维持双路径。

**就地迁移已存储的代。** 已提交的代不可变；重写它们等于移动、覆盖或删除已发布数据，破坏读者依赖的版本契约。

**在 core 保留打包行编码。** 编码器只为输出退役词汇存在；把它限制在离线 v18↔v20 迁移工具内，可让运行时写路径保持单一形状，同时已发布数据库仍可升级。

## Consequences

`sourceEventSeqs` 不再出现在 `assistant/message` 上；读者对 v4 之前的持久事件保留 legacy 回退。Gateway 媒体收集、会话安全扫描、token 计量、历史分页与投影改为读消息内容与内嵌流。History-wire 分页保留自己的物理打包载体——那是独立于会话事件词汇的传输细节。[打包 JSONL 布局](../../archived/architecture/2026-07-26-packed-chunk-rows-by-default.md)与 [SQLite 物理压缩](../../archived/architecture/2026-08-18-sqlite-physical-chunk-row-compression.md)两项决定成为退役的写路径，仅以 decode-only 兼容保留。
