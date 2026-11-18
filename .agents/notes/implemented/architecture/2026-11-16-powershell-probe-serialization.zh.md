# Agent Note: Windows PowerShell 探针不再依赖 cmdlet

Status: implemented

[English](2026-11-16-powershell-probe-serialization.md) | 中文

## Problem

每个 Windows ACL 探针、挂载检查与孤儿清扫都以含 cmdlet 的脚本派生 `powershell.exe`(`Get-Acl`、`Set-Acl`、`Get-Item`、`Get-Volume`、`Get-CimInstance`、`ConvertTo-Json`、`ConvertFrom-Json`),cmdlet 经每用户模块分析缓存解析。vitest 在并行 worker 进程中跑规格，多个冷启动 `powershell.exe` 子进程竞写共享缓存；缓存损坏后，本作业后续每次自动加载都以 `CouldNotAutoloadMatchingModule` 失败。windows-native CI lane 在 ACL 规格中复现了这种持久失败，而串行单子进程始终可靠。

## Decision

- 所有派生脚本只使用 .NET API 与语言构造：`[IO.File]::GetAccessControl`/`SetAccessControl` 处理 ACL,`[IO.FileInfo]`/`[IO.DirectoryInfo]` 做属性检查，`[Management.ManagementObjectSearcher]` 查询 `Win32_Volume`/`Win32_Process`，手工 `'{...}' -f` 输出 JSON,`[regex]` 取代 `ConvertTo-Json`/`ConvertFrom-Json` 解析。无任何模块子系统解析。
- `gateway/src/child-command.ts` 的 `runWindowsShellProbe` 仍统一管理 `powershell.exe` 派生作为第二道防线：模块级 Promise 队列做进程内串行化，文档化的 `CouldNotAutoloadMatchingModule` 在同一槽位内重试一次。
- `mountvol.exe`、`taskkill.exe` 与 POSIX 工具保留无队列路径。

## Consequences

- ACL 判定线格式保持 JSON(`owner`、`deny`、`sids`、`foreignWriters`);TS 消费方与测试 mock 的解析形状不变。
- `win32` 路径现在只对真实 OS 失败降级——损坏的 PowerShell 模块环境无法再污染判定路径。

## Alternatives considered

- 仅做进程内派生串行化——拒绝：vitest 并行 worker 仍会跨进程竞写机器级共享缓存；仅保留为纵深防御。
- 在子进程环境补 `PSModulePath`——拒绝：`scrubbedGatewayChildEnv` 已保留；模块发现成功而加载本身失败。

## Verification

- `gateway` `tsc --noEmit` 通过；全部生成脚本通过 `System.Management.Automation.Language.Parser` 解析检查；mock 后的 ACL 规格本地 51/51 通过；windows-native 规格 lane 是 CI 上的验收面。
