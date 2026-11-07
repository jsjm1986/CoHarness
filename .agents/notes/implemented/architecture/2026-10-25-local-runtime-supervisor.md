# Agent Note: Recoverable local runtime supervision

Status: implemented

English | [中文](2026-10-25-local-runtime-supervisor.zh.md)

## Problem

A Gateway killed with SIGKILL cannot run JavaScript exit cleanup. Its detached local Runtime can keep serving HTTP while a replacement Gateway lacks a process handle. Releasing admission would permit overlapping execution; retaining occupancy without recoverable ownership prevents operational recovery. The PostgreSQL retry and immutable-release decisions in [startup resilience](../bug-fix/2026-08-18-gateway-startup-resilience.md) remain applicable.

## Decision

The [local launcher](../../../../gateway/src/launcher.ts) commits a private allocation reservation before spawning an independent Node supervisor. An inherited open file description carries its exclusive kernel lease into the supervisor and direct Runtime. Gateway descriptor closure does not release inherited ownership. The journal binds the node, owner, generation, credential fingerprint, random capability, kernel boot UUID and unchanged lock inode; established control endpoints and group identities cannot change. Cancellation persists separately and stopped generations cannot reopen. Caller cancellation remains live through preparation and supervisor handoff; admission with fresh pressure observations follows private preparation. Descriptor-close failure requires confirmed process cleanup or a retained cleanup handle. Application-data collection, reviewed inventory adoption and relocation reject roots containing or contained by either local supervisor records or Gateway model locks, including administrator-approved roots; restoration cannot replace execution evidence.

Kernel boot identity is read before Runtime allocation. Its native macOS probe uses a five-second force-kill deadline, bounds output to 1024 bytes and excludes Gateway credentials. Startup cancellation stays attached until that probe physically closes; a failed or cancelled identity read cannot reach process allocation. Probe closure does not establish whether a previously owned Runtime stopped.

A positively observed different kernel boot permits a remounted device number only while the private generation record and lock inode remain unchanged. Recovery reacquires the current exclusive lock, verifies that its descriptor still names that path, and commits a terminal record with the current device witness. Same-boot device changes, changed inodes, occupied locks and failed boot probes retain uncertain occupancy. Earlier-boot recovery does not contact the saved endpoint or inspect or signal its process group.

The supervisor owns the runtime output streams and authenticated loopback control. It is the live POSIX process-group leader and signals only its own group. A recovery controller never signals a numeric PID recovered from disk. It reacquires the exact kernel lease and observes group absence before committing or accepting terminal stop evidence; a different kernel boot proves the old processes cannot remain. Missing metadata, replaced inodes, live groups or unavailable owners retain uncertain occupancy. A permission-denied group observation also retains occupancy: stop waits within its existing deadline for positive absence evidence, and a persistent denial reports unconfirmed termination. A reused group number can conservatively delay release, but cannot redirect a signal.

Local recovery is independent of graceful retention. `instancesOutliveGateway=false` retains normal local shutdown behavior; manager initialization adopts active assignments, liveness and warm reuse attach through the exact credential, and shutdown also drains adopted assignments that were never read. Already stopped assignments without a retained reservation need no process attachment. Read-only owner lookup, controller attachment and supervisor-probe failures report `503 INSTANCE_UNAVAILABLE` and retain the recorded generation and occupation; a free lease and confirmed group absence permit dead local assignments to advance. Systemd query errors propagate unless `is-active` reports exit 3 or 4 for an inactive or missing unit, as defined by [systemctl](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html#Exit%20status). Its [control-command owner](../bug-fix/2026-10-25-systemd-control-command-ownership.md) separately bounds CLI clients while retaining service-generation uncertainty.

Linux local startup probes a real user-systemd scope before selecting native descendant ownership. Its immutable reservation records `nativeRange=linux-slice`; a nonce-derived `dshruntime<nonce-without-hyphens>.slice` contains the initial Runtime scope and every process born beneath it. The local subprocess provider reads kernel cgroup membership and places probes, pipe and PTY scopes in that same slice. SDK process launches inherit it without extra credentials or environment selectors. Slice force termination includes independently grouped and reparented descendants. Recovery requires the whole slice to be empty beside the free kernel lease and absent original group; query failure retains occupancy. A recovered controller can retire the exact nonce-derived slice after supervisor failure, without signalling a saved numeric PID. Retiring empty slices also releases their manager state.

## Alternatives considered

**Gateway exit hooks.** SIGKILL bypasses them, so they cannot establish recoverable ownership.

**Persist a PID and kill it after restart.** PID reuse can direct stale cleanup at an unrelated process. The independent live leader owns signalling instead.

**Release capacity after an HTTP failure or a saved stopped phase.** Neither establishes physical exit; kernel ownership and the owned group must settle before release.

## Consequences

Each local Runtime adds a Node process, a loopback listener and private generation records. Five compiled-launcher samples on this macOS Node 25 host measure median HTTP readiness of 86.59 ms without the supervisor and 224.97 ms with it; supervisor RSS is 78288 KiB. The isolated Gateway-side fixture RSS also rises from 66848 to 83728 KiB. RSS includes shared pages. The old compiled baseline lacks an artifact fingerprint, so these host observations are illustrative and do not calibrate production capacity. Pressure admission observes host usage; the optional resident ceiling remains separate.

Preserve the node-local control directory across release replacement and application-data restores and exclude it from custom backup roots. Legacy assignments without exact owner evidence require an independently confirmed stop. Local execution supports macOS/Linux kernel locks. macOS, unavailable Linux user managers and existing process-group reservations retain the POSIX group guarantee; escaped descendants remain outside it. Windows has no new platform evidence. Upgrade Gateway and managed-computer writers together; native ownership applies to newly started allocations and requires the matching subprocess provider. Runtime diagnostic writes are best effort and forced group termination can interrupt buffering.

## Verification

The Linux-only `test:built-local-native-supervision` checks its [stable transcript](../../../../gateway/tests/expected/local-runtime-native-supervision.expected.md) through the compiled Gateway, real Loader, pipe and PTY providers, and public SDK process launcher. It covers Gateway SIGKILL, supervisor and root Runtime SIGKILL, retained occupancy while descendant scopes survive, exact recovery and independent allocations with equal public owner/generation values. The SDK fixture answers its transport handshake; this is process ownership evidence, not real model-provider validation.

Real source-launched and plain-Node compiled scenarios cover Gateway SIGKILL, exact recovery, credential isolation, terminal fencing, queued cancellation, uncooperative processes and inherited-pipe descendants. Kernel tests cover inherited ownership after Gateway descriptor closure, replaced inodes, bounded private records and cancellation. PostgreSQL verifies that recovered occupancy is reclaimed after physical exit. Compiled acceptance runs on installed Node 22, 24 and 25; its [stable transcript](../../../../gateway/tests/expected/local-runtime-supervision.expected.md) is checked by `test:built-local-supervision`.

The real PostgreSQL/Gateway/Web-profile assembly verifies authenticated personal and shared-project access, two-member reuse, Gateway SIGKILL, exact-generation recovery, unavailable supervision without extra starts and graceful replacement shutdown. Source and compiled launchers share the [expected transcript](../../../../gateway/tests/expected/local-runtime-web-assembly.expected.md); CI runs the compiled scenario after the workspace consumer build.

Read-only [recovery inventory acceptance](../../../../gateway/tests/fixtures/recovered-owner-liveness.mjs) uses PostgreSQL, authenticated Gateway HTTP and the real local controller. Missing attachment credentials and missing owner evidence return unavailable while the recorded generation and resident occupation remain unchanged. This restored-assignment scenario launches no native Runtime.
