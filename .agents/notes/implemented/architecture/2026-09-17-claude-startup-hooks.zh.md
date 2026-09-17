# Agent Note: 等待 Claude Code SessionStart hook

Status: implemented

[English](2026-09-17-claude-startup-hooks.md) | 中文

## Problem

分离运行的 SessionStart hook 可能在首轮模型请求后才注入指导。仅等待 Agent 创建不能保证请求包含启动指导。

## Decision

Claude Code 桥接在串行 `agent/created` 中等待 SessionStart。进程信号合并创建取消与桥接卸载；取消后不得注入迟到上下文，hook 失败仍记录日志而不否决创建。跟踪被等待的任务，使桥接独立于 Agent 卸载时仍能完成进程清理。

## Alternatives considered

保留分离执行仍存在竞态。调用方轮询上下文无法区分空输出和未完成初始化。已有串行创建事件提供完成保证，无需调用方另行等待。

## Consequences

Agent 创建耗时包含 SessionStart hook 的执行时间。调用方发送首条提示前即可获得启动上下文；取消会等待 hook 进程清理。Hook 失败仍不否决创建，因此创建成功不保证执行失败的 hook 提供了上下文。

## Verification

真实 shell hook 回归覆盖首轮指导、创建取消、桥接卸载与注入失败。无密钥产品 headless 快照加载真实桥接，要求模型请求包含启动指导，并检查持久日志中的来源归属。本改动不代表其他生命周期消费者或整次上游升级已完成。
