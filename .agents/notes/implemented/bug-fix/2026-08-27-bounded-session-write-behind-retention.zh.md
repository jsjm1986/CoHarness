# Agent Note: 为会话 write-behind 保留设置事件数与字节数上限

Status: implemented

[English](2026-08-27-bounded-session-write-behind-retention.md) | 中文

## 问题

write-behind controller 会保留失败批次以及后端写入期间到达的事件。后端缓慢或不可用时，单个活动会话的内存队列虽然已有事件数限制，却仍可能在没有字节上限的情况下增长。事件负载大小差异很大，因此在事件数达到有意义的阈值前，少量大事件就可能耗尽内存。

## 决策

`SessionWriteBehind` 在待处理队列与活跃批次的总和上同时执行 `maxPendingEvents` 和 `maxPendingBytes` 两项准入限制。字节限制按 controller 获取持久化所有权后的结构化副本计算其 UTF-8 JSON 编码大小。默认值为每个活动会话 100,000 个事件和 64 MiB。

活跃批次会一直计入限制，直到其持久化写入结束。失败批次会恢复到较新待处理事件之前，并继续计入事件数与字节数，因此重试无法绕过任一上限。若某次准入会超过任一限制，系统会报告失败并在修改队列前抛出异常。

共享的 [`PersistenceCoordinator`](../architecture/2026-06-18-shared-persistence-write-coordinator.zh.md) 负责解析两项限制，并将其传给每个活动会话 controller。JSONL、SQLite 和 Gateway 持久化提供方在配置 schema 中公开两项字段并原样转发。限制只作用于活动 write-behind 保留，不改变持久化事件日志、存储格式或后端行数。

## 备选方案

**只保留事件数限制。** 不采纳：事件负载大小差异很大，只按数量限制会允许少量超大事件保留过多内存。

**估算 JavaScript 对象大小。** 不采纳：对象大小估算依赖运行时，且不等于持久化路径实际要序列化的字节。UTF-8 JSON 字节提供了所有一方后端共用的确定性准入单位。

**达到限制时丢弃或压缩失败批次。** 不采纳：持久化约定要求后端失败后按顺序、无损重试。拒绝新生产者可以保留已经接纳的前缀，而不是静默丢失事件。

**由各后端分别配置限制。** 不采纳：保留与重试属于协调器行为，而 JSONL、SQLite 与 Gateway 只在持久化原语上不同。共享协调器选项可以避免策略漂移。

## 验证

`packages/session/session-persistence/tests/write-behind.spec.ts` 覆盖字节限制拒绝、活跃批次计数、事件数限制拒绝和失败批次保留。提供方 schema 与生成的配置目录为 JSONL、SQLite 和 Gateway 暴露相同字段。

## 后果

每个活动会话的 write-behind 队列都有确定的事件数和序列化负载字节上限，包括等待缓慢或失败后端的批次。超过任一上限时，生产者会收到明确错误；调用方必须等待 controller 排空后重试，或选择更大的部署限制。

controller 除了已有的持久化所有权副本外，还会为保留字节估算对每个已接纳事件执行一次序列化。该配额不限制后端 I/O 时长、已持久化历史总量或跨会话聚合内存；部署仍需要会话级与进程级容量控制。
