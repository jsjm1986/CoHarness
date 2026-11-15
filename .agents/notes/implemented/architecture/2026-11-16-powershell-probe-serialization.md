# Agent Note: Windows PowerShell probes run serially

Status: implemented

English | [中文](2026-11-16-powershell-probe-serialization.zh.md)

## Problem

Every Windows ACL probe and tighten spawns `powershell.exe` through `runGatewayChildCommand`. Windows PowerShell 5.1 resolves cmdlets such as `Get-Acl`, `Set-Acl`, and `ConvertTo-Json` through a per-user module-analysis cache, and cold-starting several `powershell.exe` children concurrently lets one sibling's cache build fail another with `CouldNotAutoloadMatchingModule`. The windows-native CI lane reproduced this intermittently inside `node-private-sqlite` specs, while single children on a warm machine answer reliably.

## Decision

- `runWindowsShellProbe` in `gateway/src/child-command.ts` owns all `powershell.exe` probes: a module-level promise queue serializes the children, and a documented `CouldNotAutoloadMatchingModule` failure retries once inside the same queue slot.
- Every `powershell.exe` spawn — ACL probes and tighten, the SQLite provisioning proof, the local-mount volume check, and the orphan-process sweep — funnels through the serialized helper. `mountvol.exe`, `taskkill.exe`, and POSIX tools keep the unqueued path.

## Consequences

- Powershell probe latency becomes first-come-first-served; the serialized burst adds at most one child deadline per queued probe.
- A persistent module failure still propagates after the single retry, so the fix narrows cold-start flakes without masking real command errors.

## Alternatives considered

- Rewriting the probes in pure .NET (`[IO.File]::GetAccessControl` instead of `Get-Acl`) — rejected for this change: correct but a larger surface, and the cache race also affects `Get-CimInstance` sweeps that have no cmdlet-free equivalent in this layer.
- Seeding `PSModulePath` in the child environment — rejected: `scrubbedGatewayChildEnv` already preserves it; the failure is a race, not a missing path.

## Verification

- `gateway` `tsc --noEmit` passes; the windows-native `node-private-sqlite` spec lane is the acceptance surface on CI.
