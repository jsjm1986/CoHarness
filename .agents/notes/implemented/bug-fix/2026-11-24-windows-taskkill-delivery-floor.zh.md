# Agent Note: 为 Windows taskkill 助手设置超时下限并增加直接子进程终结兜底

Status: implemented

[English](2026-11-24-windows-taskkill-delivery-floor.md) | 中文

## 问题

`taskkillProcessTree` 用属主 spawn 的 `graceMs` 约束其同步 `taskkill` 助手进程——而这正是调用方为让测试走快速升级路径而压到 100–200ms 的预算。在 `windows-2025-vs2026` 托管 runner 镜像 `20261111.635` 上，助手进程的创建加运行经常超过该预算：`spawnSync` 遂在助手送达 `/T /F` 之前将其 SIGKILL，目标进程树存活，而 `fallbackOwner.waitForExit`——为把静默作为拆除后置条件而刻意无界——对 `child.exitCode` 无限轮询。lsp-stdio instance spec 中每个触及强制拆除的用例都烧满 180s 测试超时（master 上 24 例挂 14，本栈指纹逐字相同）；姊妹 `lifecycle.spec.ts` 约 16s 通过，因为 provider 路径经 `launchWindowsJob` 的 Job Object 终结，从不调用 taskkill。`signalTree` 此前也没有第二送达途径：当助手无法启动或无法触及进程树时，没有任何机制终结被 spawn 的子进程。

## 决定

`taskkillProcessTree` 现将助手超时下限设为 `TASKKILL_MIN_TIMEOUT_MS`（10s）：`Math.max(Math.ceil(commandTimeoutMs), TASKKILL_MIN_TIMEOUT_MS)`。属主预算仍然约束助手（挂死的 taskkill 依旧被杀），但不再能把助手启动节流在可存活下限之下。`signalTree` 的 Windows 分支在 taskkill 之后追加 `child.kill(sig)`——Node 在 Windows 上把任何信号映射为 `TerminateProcess`，因此即使助手静默失败，被 spawn 的子进程仍会发布活性循环可观察到的退出；对已退出子进程的调用与 POSIX 兜底一样被吞没。

## 备选方案

- **升级后为 `waitForExit` 设上限**——把"SIGKILL 后仍存活"视为已拆除会削弱 `LspInstance.forceTerminate` 文档化的静默后置条件，并掩盖真正不可杀的进程树而不是报告它。
- **Windows 专属 spec 排除**（`windowsUnsupportedTests`）——能让 lane 变绿，但对每个没有 Job Object 收容的 Windows 调用方，生产 fallback 路径仍留有同样的潜在挂起。
- **保持 deadline spec 断言不变**——助手超时的三处断言（`timeout: 41`、`47`、`1`）已更新为下限值；预算等值正是缺陷所在，而非契约。

## 后果

Windows fallback 拆除保住静默保证，并新增送达下限与直接子进程兜底；`createWindowsProcessInspector` 的层级保留属主预算绑定，因为其调用方传入的是真实预算而非升级测试。`taskkillProcessTree` 的三处 deadline 断言现期望 10s 下限；inspector 层级断言不变。该修复同时治愈 spec 的裸 `spawnSubprocess` 路径与任何从 Job Object 收容回退的生产 spawn。
