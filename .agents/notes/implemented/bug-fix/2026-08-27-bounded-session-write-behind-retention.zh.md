# Agent Note: 为会话 write-behind 保留设置事件数与字节数上限

Status: implemented

[English](2026-08-27-bounded-session-write-behind-retention.md) | 中文

## 问题

write-behind controller 会保留失败批次以及后端写入期间到达的事件。后端缓慢或不可用时，单个活动会话的内存队列虽然已有事件数限制，却仍可能在没有字节上限的情况下增长。事件负载大小差异很大，因此在事件数达到有意义的阈值前，少量大事件就可能耗尽内存。

## 决策

`SessionWriteBehind` 在待处理队列与活跃批次的总和上执行 `maxPendingEvents` 和 `maxPendingBytes`。控制器先检查事件数，再编码事件并计算 UTF-8 JSON 字节数。它保留活动 Session 发布的深度冻结事件。默认值为每个活动会话 100,000 个事件和 64 MiB。

活跃批次会一直计入限制，直到其持久化写入结束。失败批次会恢复到较新待处理事件之前，并继续计入事件数与字节数，因此重试无法绕过任一上限。若某次准入会超过任一限制，系统会报告失败并在修改队列前抛出异常。 controller 保留该失败，防止 Session observer 的异常包含掩盖缺失事件；其终结屏障行为由[接纳失败决策](2026-10-23-write-behind-admission-failure.zh.md)定义。

共享的 [`PersistenceCoordinator`](../architecture/2026-06-18-shared-persistence-write-coordinator.zh.md) 负责解析两项限制，并将其传给每个活动会话 controller。SQLite 和 Gateway 持久化提供方在配置 schema 中公开两项字段并原样转发。JSONL 使用独立的基于句柄的活动事件路由。限制只作用于活动 write-behind 保留，不改变持久化事件日志、存储格式或后端行数。

## 备选方案

**只保留事件数限制。** 不采纳：事件负载大小差异很大，只按数量限制会允许少量超大事件保留过多内存。

**估算 JavaScript 对象大小。** 不采纳：对象大小估算依赖运行时，且不等于持久化路径实际要序列化的字节。UTF-8 JSON 字节提供了所有一方后端共用的确定性准入单位。

**达到限制时丢弃或压缩失败批次。** 不采纳：持久化约定要求后端失败后按顺序、无损重试。拒绝新生产者可以保留已经接纳的前缀，而不是静默丢失事件。

**由各后端分别配置限制。** 不采纳：保留与重试属于协调器行为，而 JSONL、SQLite 与 Gateway 只在持久化原语上不同。共享协调器选项可以避免策略漂移。

## 验证

`packages/session/session-persistence/tests/write-behind.spec.ts` 覆盖字节限制拒绝、活跃批次计数、事件数限制拒绝和失败批次保留。提供方 schema 与生成的配置目录为 SQLite 和 Gateway 暴露相同字段。

## 后果

每个活动会话的 write-behind 队列都有确定的事件数和序列化负载字节上限，包括等待缓慢或失败后端的批次。直接 controller 调用与之后的每个持久化屏障都会明确暴露接纳失败。若活动 Session 的 observer 无法保留已接受事件，仅排空 controller 不能恢复该生命周期；部署必须在接受进一步工作前处理限制。

控制器拥有待处理和活跃批次列表。各批次与活动 Session 共享不可变事件，存储适配器只读借用这些事件。直接调用持久化接口时，仍会校验无损 JSON 并分离输入。后端 I/O 时长、持久历史总量和跨会话内存占用需要另行管控。
