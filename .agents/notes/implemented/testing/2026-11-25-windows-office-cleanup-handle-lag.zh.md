# Agent Note：重试 Office 冒烟目录树清理以容忍 Windows 句柄释放滞后

状态：已实现

[English](2026-11-25-windows-office-cleanup-handle-lag.md) | 中文

## 问题

`python runtime / release-shaped matrix / node24-win-x64` lane 在 Office 冒烟本身已经成功之后失败——"relocated Office native DOCX produced 18554 PDF bytes" 已在拆卸前打印——因为 `tempfile.TemporaryDirectory` 清理无法删除 `libreoffice-kit-win32-x64/bin/libreoffice-kit.exe`：`PermissionError WinError 32`，随后 `NotADirectoryError WinError 267`（半删除的树扰乱了错误处理器）。Windows 在进程退出后异步释放可执行映像句柄，原生引擎二进制在 harness 报告终止后仍可能短暂持有锁。冒烟 lane 无法影响该 OS 时序；单次立即删除在这个平台上本身就是错误的原语。

## 决策

`scripts/fixtures/office-render.py` 的 `workspace()` 改为显式 `tempfile.mkdtemp` 加 `remove_tree` 助手管理根目录：win32 上 `shutil.rmtree` 遇 `PermissionError`/`NotADirectoryError` 每 0.5 秒重试、限 30 秒窗口；POSIX 行为不变（单次立即删除）。产物捕获仍在删树之前运行，错误传播语义一致。真实的非锁类失败在窗口耗尽后照常抛出而非被吞，任何临时树都不会被故意泄漏——按 scripts 执行模型保有对所获路径的所有权。

## 备选方案

- **`ignore_cleanup_errors=True`**——每次锁定运行都会泄漏数百 MB 的引擎树，且同一标志会掩盖真实清理缺陷；CI runner 的一次性让泄漏在本地不可见但并不更小。
- **在 harness 内更激进地终止引擎**——harness 已报告终止；滞后发生在 OS 释放映像句柄而非产品未能杀死的存活进程，上游没有可修的正确目标。
- **在 CI 步骤内重试**——为拆卸竞态重跑整个矩阵作业会浪费本轮已产出的成功冒烟证据。

## 后果

Office 冒烟的成败信号现在反映转换契约而非 Windows 句柄释放时序。其他获取原生进程树的 fixture 在登上 win32 runner 时应复用 `remove_tree` 而非裸 `shutil.rmtree`。相关：[PTC 取消探针 yield](../testing/2026-11-25-ptc-cancel-probe-must-yield.zh.md) 与 [Windows teardown 预算余量](../bug-fix/2026-11-24-windows-teardown-budget-headroom.zh.md) 覆盖同一 lane 内独立的 teardown 类别。
