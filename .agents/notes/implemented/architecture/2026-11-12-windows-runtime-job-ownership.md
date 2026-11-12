# Agent Note: Windows local runtime Job ownership and PID-reuse fencing

Status: implemented

English | [中文](2026-11-12-windows-runtime-job-ownership.zh.md)

## Problem

Windows has no POSIX process groups, so the supervised Runtime tree relied on `taskkill /PID <groupPid> /T /F` fenced only by the kernel boot UUID. A PID reused inside the same boot still names a live process, so stale cleanup could signal an unrelated tree, and a supervisor death of any kind orphaned its Runtime tree.

## Decision

[local-runtime-win32-job.ts](../../../../gateway/src/local-runtime-win32-job.ts) binds kernel32 through Koffi in the Gateway, following the [node-windows-security-id.ts](../../../../gateway/src/node-windows-security-id.ts) loading pattern. After `spawn` resolves, the [supervisor](../../../../gateway/src/local-runtime-supervisor.ts) opens the child and assigns it to a fresh Job Object whose only limit is `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; the supervisor holds the Job handle for its whole life, so kernel cleanup ends the entire tree on supervisor death, and `TerminateJobObject` replaces `taskkill /T` as the force-stop path. Job assignment is a hardening layer, not a precondition: when it fails — for example a supervisor already nested inside a Task Scheduler Job — startup continues on the pre-Job `taskkill /T` + creation-fenced sweep, which owns the tree anyway.

The supervisor records `groupStartedAt`, its own `GetProcessTimes` creation instant in Unix epoch milliseconds, beside `groupPid` at the `starting` publish; when the FFI read itself is unavailable the field is omitted and the record keeps the boot-identity fence. The owner schema requires the witness to travel with `groupPid`, and `publish` treats an established `groupStartedAt` as immutable capability exactly like `groupPid`. Every Windows kill path in [local-runtime-control.ts](../../../../gateway/src/local-runtime-control.ts) — wedged-supervisor `taskkill` and orphan sweeping — first reopens the recorded PID and requires its creation instant to match within four milliseconds; a dead or reused PID is never signalled. Records written before the field existed keep the boot-UUID fence alone.

`scripts/ci-pr-proofs.ts` now maps `gateway/src/local-runtime-{supervisor,control,owner,win32}*.ts` and `node-{windows,private}*.ts` onto `proof_native_windows`, so Windows-owned runtime-control changes run the real `windows-2025` complete gate inventory instead of only the Wine lane.

## Alternatives considered

**Shared `spawnJobProcess` from `packages/subprocess/win32-process`.** It creates suspended children over caller-supplied OS handles, but the supervisor's `stdio[3]` credential pipe is owned by Node `spawn`; reproducing it natively would fork the credential-delivery contract for no extra ownership.

**Kill-free creation-time fencing alone.** It stops reused-PID kills but leaves orphaned trees after supervisor death; the Job gives the kernel the cleanup duty instead of a sweep.

**PowerShell `CreationDate` witnesses.** They cost a subprocess per check and return locale-formatted times; `GetProcessTimes` reads the kernel timestamp directly.

## Consequences

Supervisor death on Windows now collects the Runtime tree without the orphan sweep, which remains as the legacy-record fallback. Job assignment happens after `spawn`, so a child that exits in the gap is still stopped by the `taskkill` fallback. `groupStartedAt` extends the owner record schema without a migration because the field is optional and strict parsing ignores nothing it declares. Gateway Windows runtime-control files now trigger native Windows proof, widening that lane's trigger set.

## Verification

[local-runtime-win32-job.spec.ts](../../../../gateway/tests/local-runtime-win32-job.spec.ts) proves the unavailable contract off Windows and, when run on a Windows host, creation-instant reads, reused-PID rejection, and whole-tree termination through the Job. Owner specs cover witness persistence, the `groupPid` pairing requirement, and capability immutability on POSIX hosts. Gateway tests execute only in the Linux `gateway` CI job — the Windows-gated spec bodies have no CI lane — so the first live exercise of the Job/creation paths was the production Windows node, which caught a `readBigUInt64LE` bounds error in the FILETIME decode that no lane had ever executed.
