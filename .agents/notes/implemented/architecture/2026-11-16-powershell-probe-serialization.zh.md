# Agent Note: Windows PowerShell 探针串行化

Status: implemented

[English](2026-11-16-powershell-probe-serialization.md) | 中文

## Problem

每个 Windows ACL 探针与收紧都经 `runGatewayChildCommand` 派生 `powershell.exe`。Windows PowerShell 5.1 经每用户模块分析缓存解析 `Get-Acl`、`Set-Acl`、`ConvertTo-Json` 等 cmdlet；并发冷启动多个 `powershell.exe` 子进程时，一个兄弟进程的缓存构建会使另一个以 `CouldNotAutoloadMatchingModule` 失败。windows-native CI lane 在 `node-private-sqlite` 规格中间歇复现此问题，而热机上的单子进程始终可靠。

## Decision

- `gateway/src/child-command.ts` 的 `runWindowsShellProbe` 统一管理所有 `powershell.exe` 探针：模块级 Promise 队列串行化子进程，文档化的 `CouldNotAutoloadMatchingModule` 失败在同一队列槽位内重试一次。
- 所有 `powershell.exe` 派生——ACL 探针与收紧、SQLite 供给证明、本地挂载卷检查、孤儿进程清扫——都经串行化 helper 汇聚；`mountvol.exe`、`taskkill.exe` 与 POSIX 工具保留无队列路径。

## Consequences

- PowerShell 探针延迟变为先来先服务；串行化突发在每个排队探针上至多增加一个子进程期限。
- 持续性模块失败在单次重试后仍会传播，该修复收窄冷启动抖动而不掩盖真实命令错误。

## Alternatives considered

- 用纯 .NET 重写探针（`[IO.File]::GetAccessControl` 替代 `Get-Acl`）——本次拒绝：正确但改动面更大，且缓存竞态同样影响本层无 cmdlet-free 等价的 `Get-CimInstance` 清扫。
- 在子进程环境中补 `PSModulePath`——拒绝：`scrubbedGatewayChildEnv` 已保留该变量；失败是竞态而非路径缺失。

## Verification

- `gateway` `tsc --noEmit` 通过；windows-native `node-private-sqlite` 规格 lane 是 CI 上的验收面。
