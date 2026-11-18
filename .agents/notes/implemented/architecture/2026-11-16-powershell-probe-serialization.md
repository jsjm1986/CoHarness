# Agent Note: Windows PowerShell probes are cmdlet-free

Status: implemented

English | [中文](2026-11-16-powershell-probe-serialization.zh.md)

## Problem

Every Windows ACL probe, mount check, and orphan sweep spawned `powershell.exe` with scripts that resolved cmdlets (`Get-Acl`, `Set-Acl`, `Get-Item`, `Get-Volume`, `Get-CimInstance`, `ConvertTo-Json`, `ConvertFrom-Json`) through the per-user module-analysis cache. Vitest runs specs in parallel worker processes, so several cold `powershell.exe` children race the shared cache; once corrupted, every later autoload fails with `CouldNotAutoloadMatchingModule` for the rest of the job. The windows-native CI lane reproduced the persistent failure inside the ACL specs while serialized single children stayed reliable.

## Decision

- Every spawned script now uses only .NET APIs and language constructs: `[IO.File]::GetAccessControl`/`SetAccessControl` for ACLs, `[IO.FileInfo]`/`[IO.DirectoryInfo]` for attribute checks, `[Management.ManagementObjectSearcher]` for `Win32_Volume`/`Win32_Process`, manual `'{...}' -f` JSON output, and `[regex]` parsing in place of `ConvertTo-Json`/`ConvertFrom-Json`. Nothing resolves through the module subsystem.
- `runWindowsShellProbe` in `gateway/src/child-command.ts` still owns `powershell.exe` spawns as a second line of defense: a module-level promise queue serializes children in-process and a documented `CouldNotAutoloadMatchingModule` retries once inside the slot.
- `mountvol.exe`, `taskkill.exe`, and POSIX tools keep the unqueued path.

## Consequences

- The ACL verdict wire format stays JSON (`owner`, `deny`, `sids`, `foreignWriters`); TS consumers and test mocks keep their existing parse shape.
- `win32` paths now degrade only on real OS failures — a broken PowerShell module environment cannot corrupt the verdict path.

## Alternatives considered

- Per-process spawn serialization alone — rejected: vitest's parallel workers still race the machine-shared cache across processes; it was retained only as defense in depth.
- Seeding `PSModulePath` in the child environment — rejected: `scrubbedGatewayChildEnv` already preserves it; discovery worked and the load itself failed.

## Verification

- `gateway` `tsc --noEmit` passes; all generated scripts pass `System.Management.Automation.Language.Parser` parse checks; the mocked ACL specs pass 51/51 locally; the windows-native spec lane is the acceptance surface on CI.
