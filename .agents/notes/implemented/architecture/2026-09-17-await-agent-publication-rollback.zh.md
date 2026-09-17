# Agent Note: 在 Agent 创建回滚范围内等待发布

Status: implemented

[English](2026-09-17-await-agent-publication-rollback.md) | 中文

## Problem

从 `try` 块直接返回异步发布操作，会让其拒绝绕过创建事务的 `catch`。创建报告失败后，已进入注册表的 Agent 和 Session 可能仍未移除。

## Decision

AgentLoop 私有的 `PreparedAgent.publish()` 返回 Promise。`setupAndPublish()` 在现有回滚处理范围内等待它完成，并在传播错误前等待清理完成。公开创建事件保留同步语义；本次改动不实现异步 `agent/created` 初始化。

## Alternatives considered

**直接返回发布 Promise。** 成功结果不变，但拒绝会绕过回滚。两条发布失败测试会拒绝这种实现。

**同时迁移创建事件。** 串行初始化还需要一起迁移排队输入控制、取消所有权和全部事件消费者。该迁移与私有发布操作分开实施。

## Consequences

创建失败会清理注册表，并允许复用同一身份。测试覆盖 `session/created` 和 `agent/created` 两个失败点，无轮询地断言清理完成，并使用同一 id 重新创建。现有拦截、生命周期、恢复和配置会话测试覆盖保持不变的行为。本次准备性重构不改变 Session 事件 schema、SDK 输出或模型可见轨迹。
