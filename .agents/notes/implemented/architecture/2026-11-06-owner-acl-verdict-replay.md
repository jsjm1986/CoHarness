# Agent Note: The local-runtime owner store replays Windows ACL verdicts within a bounded window

Status: implemented

English | [中文](2026-11-06-owner-acl-verdict-replay.zh.md)

## Problem

Every `LocalRuntimeOwnerStore.read` on Windows resolved the owning directory's and the record file's ACL privacy by spawning `powershell.exe` — two child processes and roughly one to two seconds per read on the production node. The read runs inside `LocalRuntimeControl.isAlive` on every proxied request, so after the rest of the node request path fell to tens of milliseconds the probes became the dominant remaining Windows cost. POSIX answers the same verdicts from stat metadata for free. The [Windows local Runtime execution](2026-11-04-windows-local-runtime-execution.md) stack made these reads hot without changing their probe cost.

## Decision

`privateFileState` and `privateDirectoryState` in [node-private-file.ts](../../../../gateway/src/node-private-file.ts) accept an optional `WindowsAclProbe` — a `(file, signal) => Promise<PrivateFileState>` verdict resolver that defaults to the exported `probeWindowsAclPrivate`, the real PowerShell spawn. The delegation sits below the fresh `lstat` and reparse-point checks, so the only work a resolver can amortize is the child process itself; POSIX call sites return before the parameter is read.

`LocalRuntimeOwnerStore` in [local-runtime-owner.ts](../../../../gateway/src/local-runtime-owner.ts) injects per-instance resolvers. The owning directory replays a committed 'private' verdict while `PRIVATE_ACL_CACHE_MS` (10_000) has not elapsed. The record file replays only while the just-opened file's stat identity — `mtimeMs`, `ctimeMs`, `size` — still matches the verdict that was earned, because republish renames a new file into place and a stale verdict on a new inode is the dangerous window. 'unreadable' and 'not-private' never replay: failures re-probe on the next call, which keeps the check fail-closed with no recovery delay.

The staleness bound covers only a foreign ACL change on an otherwise unchanged file or directory for up to ten seconds. The record is still opened, its bytes read, schema parsed, generation identity and capability compared, and lock-inode witness re-checked on every call. The ACL verdict guards the record's control bearer at rest; the per-request fences that prove the record belongs to this generation are unchanged.

## Alternatives considered

**Replay the whole verdict, lstat and mode/uid checks included.** Rejected: skipping `privateFileState`/`privateDirectoryState` wholesale would drop the per-call reparse-point check on Windows and would change POSIX behavior, whose mode/uid verdicts are free and stay per-call.

**A module-level or path-keyed shared cache.** Rejected: shared state would outlive the store instance it describes and could leak verdicts across generations and callers; per-instance fields die with the store and carry no cross-boundary state.

**Key the record verdict on inode rather than stat identity.** Rejected as unnecessary: `mtimeMs`/`ctimeMs`/`size` already change on every republish rename and are read from the open handle on every call, so no extra stat is needed and an unchanged identity means unchanged observed metadata.

## Consequences

A proxied request that previously paid one to two seconds of PowerShell now pays it once per ten-second window; `acquire`, `acquireExisting`, `cancel` and the publish/recovery reads share the same instance replay. The cost is a bounded stale-verdict window in which a foreign ACL grant added to an untouched object can still read as 'private' — accepted because the record bytes, capability and lock-inode fences stay per-request and the verdict guards the loopback bearer's storage, not the bearer exchange itself.

## Testing

`local-runtime-owner-acl-cache.spec.ts` counts `runGatewayChildCommand` calls under a `win32` platform shim: three reads spawn once per probe, a renamed replacement record re-probes the file but not the directory, a 'not-private' verdict never replays and recovers on the next read, and a mocked `Date.now` confirms replay ends exactly at the bound.
