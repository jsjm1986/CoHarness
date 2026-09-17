# Agent Note: Agent 发布期间暂存输入

Status: implemented

[English](2026-09-17-agent-publication-input.md) | 中文

## Problem

创建监听器可以在发布成功前排队唤醒输入。此时开启轮次，会让创建随后失败的 Agent 提前执行任务。

## Decision

AgentLoop 在已有维护操作中执行 setup 和发布。成功完成后释放排队唤醒；发布失败则先以 `disposed` 取消维护，再由回滚处理器释放资源。维护任务在 disposed 取消后不会重放唤醒，即使收件箱被保留也是如此。

## Alternatives considered

**增加单独的 ready 标记和队列。** 维护机制已负责输入延迟和完全停稳，第二套机制会重复这些职责。

**只在外层回滚处理器中取消。** 维护任务先于外层处理器退出，此时可能已重放排队唤醒。

## Consequences

创建表现为可观测的维护活动。监听器不得在初始化期间等待 Agent 自身进入空闲。公开创建事件仍为同步事件，不等待监听器返回的 Promise。串行事件迁移尚未完成。

七条单测覆盖成功发布、发布失败、disposed 维护后保留输入、重复取消、重放期间根作用域卸载，以及普通取消后有无新唤醒的两种情况。驱动无法进入正在关闭的发起者作用域时，会回到空闲并结算预留的完成 Promise，不启动轮次。产品 headless CLI 快照固定发布拒绝且未开启轮次的输出；现有 TypeScript SDK 快照保持原预期输出。Python 打包运行时预期输出尚未验证；完整生命周期迁移尚未达到可发布状态。
