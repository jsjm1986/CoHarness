# Agent Note: 原生能力探测持有客户端直到关闭

Status: implemented

[English](2026-10-29-native-capability-probe-closure.md) | 中文

## 问题

功能沙箱探测在选择隔离方式前同步运行。忽略 SIGTERM 的原生客户端可能无限期超过 Node 配置的超时，阻塞选择过程和宿主事件循环。调用方不能把超时请求当作所有权已结束，也不能据此判断隔离可用。

## 决策

[本地沙箱提供者](../../../../packages/sandbox/sandbox-local/src/index.ts)与[公开 Landlock 探测](../../../../native/system/packages/entry/src/index.ts)在既有原生命令期限到期时使用 SIGKILL。同步返回发生在客户端关闭之后。超时使候选不可用；提供者继续声明的运行器链并缓存已完成的结果。失败不授权未隔离的目标执行。能力探测属于基础准备，与已准入目标任务分开记账。

[systemd 客户端决策](2026-10-25-systemd-control-command-ownership.zh.md)独立负责控制命令及未知的受管进程范围。[原生发布决策](../process/2026-08-06-in-repository-landlock-release.zh.md)负责源码和产物发布。客户端关闭及探测失败都不能证明受管任务已停止，也不能证明内核实施隔离。

## 考虑过的替代方案

**让消费方 Promise 与计时器竞争。** 同步探测会阻塞该线程的计时器；不关闭客户端便报告失败会遗留存活进程。

**假定普通超时信号能关闭每个客户端。** 辅助程序可以忽略 SIGTERM。探测在返回结果前持有强制关闭责任。

## 影响

隔离后端不可用时，会在配置期限后拒绝或转向下一个声明的候选。已缓存的不可用结果沿用提供者既有重试策略。这些规则不改变运行器参数、拒绝分类或内核隔离标准。POSIX 真实客户端测试覆盖命令关闭；Windows 与真实 Linux 内核验收仍由各自平台负责。
