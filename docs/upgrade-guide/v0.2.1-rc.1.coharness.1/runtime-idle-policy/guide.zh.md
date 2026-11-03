---
kind: upgrade-guide
description: "受管 Runtime 自动空闲回收需要明确选择按需策略，并通过受认证的后台工作检查。"
---

# 受管 Runtime 空闲策略

[English](guide.md) | 中文

## 变更

受管 Runtime 默认保留已经运行的进程。`HGW_IDLE_TIMEOUT_MS` 仅在明确选择按需策略、Host 认证检查和资源原子检查均通过后生效。旧版本或不可用的 Host 会保留运行，避免浏览器断开后停止后台和定时工作。

## 迁移

1. 有定时任务、监听器或未适配自开发插件的 Runtime 保留默认常驻模式。定时器要求原 Host 进程持续运行，本版本不提供进程外定时启动。
2. 对已适配的 Runtime，通过现有设置提供方将 `runtime-execution.mode` 设为 `on-demand`。其自身 `settings.yaml` 中对应 `runtime-execution: { mode: on-demand }`。项目写入需要现有项目管理员权限，设为 `resident` 可保留进程。
3. 有待处理或未来工作的自开发插件注册同步全局 `runtime/idle-release-check` 监听器，在执行和清理完成前返回 `busy`。适用时复用现有确切 Agent 的资源检查。作业记录强制失败后，仍保留原始生产方的资源释放确认；确认 promise 拒绝或清理失败会阻止自动空闲释放，需通过现有管理员控制处理尚未确认结束的工作。
4. 升级应保留运行任务。Gateway 恢复接管时如果缺少原挑战凭据，会保留该进程；后续获准的重启可恢复正常空闲探测。
5. 验证浏览器断开后，活动定时任务和长任务仍在运行。明确选择按需的 Runtime 只有在工作和未来义务结束、且超过配置的空闲时间后才可回收。读取电脑目录不能启动未使用的 Runtime。

参见[Runtime 设置与生命周期参考](../../../../packages/context/gateway-runtime/README.zh.md)。
