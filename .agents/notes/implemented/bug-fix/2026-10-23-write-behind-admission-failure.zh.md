# Agent Note: 让写入队列接纳失败持续传递到持久化屏障

Status: implemented

[English](2026-10-23-write-behind-admission-failure.md) | 中文

## Problem

活动 Session 在通知 observer 前提交事件，并包含 observer 异常。有界持久化 observer 可以拒绝该事件而不让 append 失败。之后只 flush 已保留前缀，不能证明完整活动日志已持久化。

## Decision

[`SessionWriteBehind`](../../../../packages/session/session-persistence/src/write-behind.ts) 保留首次接纳失败。它拒绝进一步接纳，排空已保留工作，并让之后每次 flush 都以该失败拒绝。即使保留前缀已排空，controller 在生命周期所有权上仍被视为非空，因此退役和后端拆卸不能掩盖缺失序号。

[保留上限](2026-08-27-bounded-session-write-behind-retention.zh.md)与可恢复的后端写入失败相互独立。失败的后端批次保留数据并可重试；未保留的活动事件不能仅靠排空或在别处增加容量恢复同一 controller。SQLite 和 Gateway 共享该 controller；JSONL 的句柄路由独立。

## Alternatives considered

- **成功写入前缀后清除错误。** 不采纳：存储仍缺少已接受的活动事件。
- **在配额之外保留被拒绝的载荷。** 不采纳：这会在后端失败期间绕过事件数与字节上限。
- **给核心 Session 增加提交前持久化钩子。** 暂缓：它会改变同步 Session 发布 API 和每个提供方；拒绝有缺口的屏障可以保留当前 observer 语义。

## Consequences

配置的保留上限可能阻止进度，直到受影响生命周期被替换并处理部署容量。显式 flush 拒绝；Cordis 通过常规的拆卸异常包含渠道报告拆卸聚合错误。不改变 Session 事件、格式代际或 SDK 转录。

## Verification

[SQLite 回归](../../../../packages/session/session-persistence-sqlite/tests/retention-overflow.spec.ts)通过真实 Session 发布覆盖事件数与字节超限。它比较保留的存储前缀与更长的活动日志，要求再次 append 前后重复 flush 均失败，并检查拆卸聚合错误。controller 测试保留活跃批次计数和有序后端重试覆盖。
