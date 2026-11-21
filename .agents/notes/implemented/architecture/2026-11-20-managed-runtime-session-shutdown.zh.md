# Agent Note: 托管 Runtime 停止时验证 Session 持久化

Status: implemented

[English](2026-11-20-managed-runtime-session-shutdown.md) | 中文

## 问题

Agent loop、Session 持久化和其余 profile 插件作为同级组件卸载。持久化可以在活跃 Agent 写入 `step/end` 与 `turn/end` 前移除实时事件监听器。进程可能成功停止，却仍需在恢复时合成这些缺失事件。普通 Agent 释放还会清空已准入的待处理输入，而托管重启需要保留这些输入。

## 决定

[托管 profile 启动器](../../../../apps/cli/reference/README.zh.md#managed-launch)在开始清理前关闭根 Agent 执行准入。[Agent loop](../../../../packages/core/agent-loop/README.zh.md#planned-shutdown)关闭 inbox 提交与创建路径，取消并等待活跃工作，并等待 Agent 作用域释放其生产者。随后每个实时 Session 关闭追加，在存储监听器仍挂载时刷新日志，再通过持久化提供方验证最终序号。已准入且等待步骤或轮次领取的用户输入保留在日志中。检查点和 profile 清理均完成后，启动器向监督进程报告成功。

[Gateway](../../../../gateway/README.zh.md#performance-and-runtime-admission)分别确认进程范围退出与 Session 持久化。本地监督进程持有分配租约时记录与子进程协商的结果。systemd Runtime 用确切代次的启动凭据签署回执，Gateway 在进程退出后验证。项目存储在该代次停止期间结合当前数据放置、写入权限及写入代次，允许追加和回读现有 Session 的后缀。

本地监督进程通过继承的 IPC 通道把停止期限传给托管 Host。已经开始的检查点可以在五秒的信号停止期限之后完成，监督进程仍会按自身期限终止整个进程范围。节点排空对全部批次使用同一个截止时间，超时后如实报告缺少的回执。

## 考虑过的替代方案

调整组合包配置顺序仍会让同级组件并发卸载。`turn/end` 事件或 Agent `idle` 通知只证明本地进度，持久化此时可能仍未完成。单独等待写入句柄的 `close` 会在事件路由监听器已解除时遗漏事件。为普通轮次统一增加更强的同步检查点会增加模型交互开销，也无法解决卸载顺序问题。

## 后果

计划停止在有界时间内完成后端回读，并独立于进程退出报告失败、超时或强制终止。普通 profile 释放沿用原有生命周期。单元测试挂起活跃请求与最终检查点，并在两种挂载顺序下从 JSONL 回读关闭的轮次和排队输入。实际写入拒绝会使托管排空失败。无密钥 Web CLI 转录验证 IPC 成功、经认证的信号回执、检查点拒绝，以及作用域释放器记录的失败。
