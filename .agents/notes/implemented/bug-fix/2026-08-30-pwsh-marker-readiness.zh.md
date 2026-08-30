# Agent Note: 不要在 inferred idle 时返回持久 pwsh 输出

Status: implemented

[English](2026-08-30-pwsh-marker-readiness.md) | 中文

## Problem

macOS PTY backend 可能在 PowerShell 已显示提示符、但包装命令的完成 marker 尚未进入终端缓冲区时报告 `inferred_idle`。如果此时返回部分 viewport，普通命令输出就会丢失，托管 macOS 上的持久 pwsh 路径会失败。

## Decision

持久 pwsh consumer 只在精确的 `stdin_read` 结果下返回提示符回退输出。`inferred_idle` 结果继续现有 marker/readback 循环，直到 marker 到达、shell 退出或命令 deadline 到期。这遵循 terminal 契约：inferred idle 不能证明前台命令已经完成。

## Verification

持久 pwsh 工具测试覆盖了先看到提示符的 inferred-idle 结果、再收到带 marker 的读取，测试已通过。Terminal PowerShell 集成测试使用跨平台就绪断言，并为托管 macOS 启动增加输出等待预算。Bash 行为及现有 timeout/reset 路径保持不变。

## Alternatives considered

**把所有看到提示符的结果都视为完成。** 拒绝，因为 PTY 中提示符可见与包装命令完成是两个独立事件。

**提高全局 idle-silence 默认值。** 拒绝，因为这会给所有 terminal 方言增加延迟，也不能证明前台命令已完成。

**忽略托管 macOS 失败。** 拒绝，因为同一个竞态可能在任何较慢的 PowerShell 主机上丢失面向模型的命令输出。

## Consequences

持久 pwsh 命令在观察到 inferred-idle 后可能继续等待 marker，但总时长受配置的命令 timeout 限制。主动替换或占用 shell 的命令仍使用现有精确就绪回退和重置行为。
