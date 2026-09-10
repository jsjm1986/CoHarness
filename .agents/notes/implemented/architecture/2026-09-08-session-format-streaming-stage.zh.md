# Agent Note：增量 Session 格式迁移阶段

Status: implemented

[English](2026-09-08-session-format-streaming-stage.md) | 中文

## 问题

CoHarness 目前通过整体 artifact 迁移 API 校验旧 Session。这样可以保持正确性，但能够增量读取数据行的提供方没有格式层提供的接口，无法逐事件转换而不再构建一份完整 artifact。

## 决定

Session 格式链现在提供可选的逐事件迁移阶段。每个相邻迁移可以创建有状态阶段，并同步发出已校验的目标事件；未提供阶段的迁移继续使用现有整体 artifact 方法。v2→v3 阶段会把请求头系统提示提升为持久化 `system/message` 事件，并在不修改源 generation 的前提下重映射后续 surface 引用。Assistant attempt 会在保留现有 chunk 词汇的同时携带紧凑流记录。公开 Session 事件和持久化契约继续兼容既有 CoHarness 消费方。提供方必须先增加增量原始行读取，再使用该阶段降低内存占用。

## 考虑过的替代方案

**只保留整体 artifact 迁移。** 对能够增量读取数据行的提供方，这会产生可避免的峰值内存，并阻止有界取消，因此不采用。

## 后果

无需一次性改动所有现有迁移或提供方即可提供流式接口。当前 v0/v1 迁移提供直通阶段，v2→v3 执行系统历史转换；JSONL 与 Gateway 提供方的接入仍是独立实现，因为它们分别负责物理读取、解码和发布。

整体 artifact 执行保留每个相邻目标版本的校验器；流式执行由阶段负责校验输出。阶段按源到目标的顺序刷新，确保下游阶段结束前收到上游尾部事件。JSONL 明文读取按字节窗口扫描，不可变后继 generation 在临时文件写入后重新校验源 revision。后继 generation 编码使用可配置批次，coordinator 接管提供方独占的事件，避免冗余快照复制。压缩读取和 preparation 仍会物化完整数组。
