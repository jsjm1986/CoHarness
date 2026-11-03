# Agent Note: Windows local Runtime execution

Status: implemented

English | [中文](2026-11-04-windows-local-runtime-execution.zh.md)

## Problem

[Windows node enrollment](2026-11-04-windows-node-enrollment.md) admitted `win32` connectivity but reported `executionReady: false`: the local Runtime ownership stack was POSIX-only. `LocalRuntimeOwnerStore` acquired its lease by `flock` on an inherited descriptor, `GatewayModelBudget` used the same pattern, the supervisor re-adopted that descriptor, config path validation rejected `C:\`-style roots outright, and the generation commit fsynced the state directory (EPERM on Windows).

## Decision

`executionReady` is now a real per-node capability field: the connect payload carries it (`z.literal(false)` relaxed to `z.boolean()`), `node-access` persists it on the lease row, and the directory returns it. The node reports it only when `localGatewayUrl` is configured — connectivity never implies execution.

The kernel lease on Windows is a named pipe `\\.\pipe\dsh-owner-<sha256(lockPath)>` instead of `flock`: exclusive `createNamedPipe`-equivalent listen, automatic kernel release on process death, and no descriptor to inherit — the supervisor claims the lease itself via `LocalRuntimeOwnerStore.adopt`, so `stdio` passes no fd slot on `win32`. The `.lock` file stays as the durable inode witness; `stat.ino`/`dev` are real file indexes on NTFS, so witness equality is unchanged. `EADDRINUSE` maps to the same contention path as `flock` `EAGAIN`. `GatewayModelBudget` gained the same win32 branch.

Process control: `detached` spawn still works, `process.kill(pid, 0)` is the liveness probe, and group termination uses `taskkill.exe /PID <pid> /T /F` — there is no process-group signal on Windows. Boot identity comes from `Get-CimInstance Win32_OperatingSystem.LastBootUpTime` via `localKernelBootId`.

Path validation in `config.ts` switched from hardcoded `posix.*` to a platform alias (`isAbsolute`, `relative`, separator checks), so `C:\harness-state` roots validate on Windows while `..` escape checks keep working. The generation commit now calls `syncStateDirectory`, which no-ops on Windows (NTFS journals the rename; directory `fsync` returns EPERM) — the same helper `node-private-file` already used.

## Alternatives considered

**Keep fd-4 descriptor inheritance.** Node does not inherit arbitrary HANDLEs as fd slots on Windows — `EBADF` in empirical probes — while `stdio` pipes (fd 0-3 and `ipc`) do cross over, matching how the credential fd3 channel already works.

**PID-based lease file with liveness polling.** PID reuse plus polling latency makes stale-owner detection unsound; the named pipe gives the same kernel-held, death-released semantics as `flock` with no polling.

**Keep POSIX-only path checks and special-case Windows.** Every `C:\`-rooted config value failed validation; a single platform alias keeps all seventeen sites consistent.

## Consequences

A Windows node with `HGW_NODE_LOCAL_GATEWAY_URL` reports `executionReady: true`, serves the center's forwarded `?dshNode=`/`?dshRuntime=` traffic through the node service stream, allocates managed Runtimes, and owns their lifecycle: start, readiness, stop via `taskkill` tree-kill, and generation fencing (`INSTANCE_GENERATION_CHANGED` on stale generations). Verified end-to-end against the production center on Windows Server 2025: allocation → `observedState: "ready"` → real headless task output → stop → restart at generation+1 → stale-generation rejection. Two optional plugins (`llm-pi-ai`, `session-telemetry-otel`) degrade when their npm deps are absent from the payload; `dsh web` still serves.

## Verification

Manual end-to-end on Windows Server 2025 against the deployed center (release `coharness-full-real-20261104-r49-winexec`): connect advertises `executionReady:true` and persists `execution_ready=t`; forwarded admin calls return `x-dsh-target-node`; `POST /admin/api/users/1/runtimes?dshNode=` allocated a Runtime, `start` reached `ready` (supervisor → `bin.js web` process tree confirmed), `stop` killed the tree, `start` produced generation 21, and a stale-generation stop returned `INSTANCE_GENERATION_CHANGED`. Gateway `tsc` is clean; the native test lane remains the owner of repeat coverage.
