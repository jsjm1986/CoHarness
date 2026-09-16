# Agent Note: cross-process session write lease

Status: implemented

English | [中文](2026-08-31-cross-process-session-write-lease.zh.md)

## Problem

The JSONL backend's write-handle claim excluded a second writer only inside one backend instance, and the cross-process layer below it was a create-and-probe lock file: `open('.locks/<id>.lock', 'wx')` followed by a recorded-pid liveness check and unlink-on-stale. That carried the whole stale-lock problem family — a dead holder's file had to be probed and deleted, the probe could misjudge a foreign or reused pid, and the delete itself could race a live owner's re-creation. Two processes — two Gateway replicas during a rolling deploy, or a host beside an SDK runtime — needed durable write ownership whose arbiter lives outside every writer process, because no writer outlives every failure mode.

## Decision

`SessionWriteLease` (packages/session/session-persistence-jsonl/src/lease.ts) holds a kernel lock on `<root>/.locks/<encoded-id>.lock` for the whole life of a write handle: POSIX takes a non-blocking `flock(2)` through the prebuilt `@deepseek-ai/node-addon-system/flock` binding (consumed as the published npm package; `native/landlock-run` stays the local native source of record), and Windows holds a named kernel semaphore (count 1) derived from the canonical lock path (`CreateSemaphoreW` in src/win32.ts beside the existing koffi bindings) — a kernel object with no filesystem footprint, destroyed with its last handle. Contention maps to `SessionAlreadyOwnedError`; the kernel releases the lock when the holder's descriptor or handle closes, including on any process death, so a crashed holder never blocks a successor and no expiry bookkeeping exists. A live but wedged holder keeps the lock until its process exits: expropriating a stalled writer was rejected because its resumed appends would tear the log, and on POSIX removing the lock file remains the explicit forfeit for that case. Because a POSIX lock names an inode rather than a path, acquisition verifies the locked inode is still the file at the lock path and retries otherwise. The lock is taken at `openHandleAsync(id, 'write')` under the root's `.locks/` directory rather than beside the log, so an unmaterialized session still leaves no artifact footprint; release never removes the lock file, preserving the stable inode later lockers verify against.

**Legacy pid record.** The replaced mechanism left files that a previous-version process reads as `{pid}` records. Acquisition therefore creates exclusively, and on an existing file reads the record first: a live pid is refused exactly as a legacy holder would refuse — which also covers a kernel-lock holder, since it publishes the same record — while a dead, absent, or self-owned record proceeds to `flock` arbitration. A held lock rewrites the record to its own live pid, so a legacy contender keeps seeing a live owner rather than residue it might unlink under the flock. Mixed-version writers on one root therefore keep mutual exclusion in both directions; the residual window is a legacy file with a dead record that a legacy process unlinks and recreates during takeover, which the inode verification absorbs.

## Alternatives considered

**Create-and-probe pid file (the mechanism this replaces)** — existence-locked file plus pid liveness plus unlink-on-stale. It keeps stale-lock recovery but is a distributed algorithm in miniature whose every step races the owner it judges: pid reuse, foreign-pid EPERM, probe-then-delete windows, and no arbitration primitive underneath. Kernel arbitration deletes the whole family, at the cost of a native binding dependency and the wedged-holder semantics above.

**TTL record with renewal and claim-by-rename** — the design upstream evaluated and rejected for the same reason: renewal timers, loss detection, and takeover claiming still allow bounded dual-writer overlap (one renewal interval).

**`proper-lockfile`** — the npm ecosystem's staleness-plus-touch implementation of the same TTL model. It retains the delete-then-recreate takeover race, detects compromise by mtime and inode (weaker than an owner token), and has had no release since 2021.

**Windows exclusive-open sharing mode (`CreateFileW` denying `FILE_SHARE_WRITE`)** — pins the lock file's name and directory while held: a still-open handle blocks recursive removal of the session root and temp-root cleanup alike. The named semaphore keeps kernel arbitration with zero filesystem footprint.

**Hand-rolled ffi for POSIX too (`flock(2)` via koffi)** — the prebuilt binding keeps binding selection and asynchronous errno handling in one audited package; the Windows side retains the koffi bindings `win32.ts` already owns.

## Consequences

Cross-process exclusion requires the platform's prebuilt system binding, one persistent lock file per written session id under `.locks/` that release deliberately leaves in place, and the wedged-holder rule: a stuck process blocks that session's writers until it exits. It buys immediate crash recovery (no waiting period), no renewal traffic, and the removal of every takeover race the probe design managed rather than prevented. Advisory `flock` is unreliable on some network filesystems (NFSv3); a root on such a mount degrades toward in-process-only exclusion. Deleting a live session's lock file forfeits exclusion on POSIX by design — the harness never does so.
