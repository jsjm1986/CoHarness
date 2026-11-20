# Agent Note: Runtime survivor retention with launch stamps

Status: implemented

English | [中文](2026-11-11-runtime-survivor-retention.zh.md)

## Problem

A Gateway restart does not prove that a Runtime has finished its work. A release mismatch also does not prove quiescence: a process can still own a long task, scheduled delivery, or plugin cleanup while its replacement uses different code.

## Decision

The Gateway retains supervised processes by default. Each generation records a content-addressed launch stamp covering resolved CLI and Web runtime packages, their shipped code and assets, the toolchain, supervisor, credential format and materialized policy inputs. Production build records the package digest and release activation verifies it. Compatible survivors reattach with their original generation and credentials. The stamp is persisted with the generation claim in `instances.launch_stamp`.

`inspectUpgradeSurvivors()` reports incompatible and unknown generations without stopping them. New forwarding remains fenced: `liveEndpoint` refuses incompatible stamps and `ensureRunning` reports that the process is retained pending a safe upgrade, warns that Gateway restarts can interrupt tasks, and asks an administrator to confirm a safe stopping point. Reconciliation observes supervisor liveness independently of release compatibility; only confirmed process death permits failure cleanup. Missing supervision retains capacity.

Runtime bearer authentication continues checking current generation, node lease, membership and policy. A launch-stamp mismatch alone does not revoke execution authority. Process retention does not retain authorization-stream liveness: Gateway shutdown closes authorization and forwarding connections, and an interrupted execution watch cancels affected Agent work, aborts tools and stops jobs. Explicit administrator stop, access revocation and configured shutdown drain keep their existing termination semantics. `HGW_DRAIN_RUNTIMES_ON_SHUTDOWN=false` skips process termination; neither value guarantees uninterrupted tasks across a Gateway restart.

## Alternatives considered

**Terminate on every stamp mismatch.** Rejected because a code fingerprint is not proof that background work has settled; a fixed termination grace interrupts long work.

**Forward new work to any survivor.** Rejected because changed launch policies and protocol inputs must still prevent new admission to incompatible code.

**Assume a survivor is idle when its challenge credential is unavailable.** Rejected because unknown activity cannot authorize termination. Even an authenticated idle response is a point-in-time observation and does not prevent new work. A safe automatic replacement requires a separate authenticated, race-free quiescence protocol.

## Consequences

An incompatible survivor requires an administrator to stop and start it after its work reaches a safe stopping point. New requests receive an explicit unavailable response; accepted work can continue only while its execution authority and required connections remain valid. Gateway deployment requires preventing new user and background work from entering, then waiting for active work and cleanup to finish before shutdown. An idle challenge alone cannot establish that condition. Keep old immutable release directories until their survivors stop; lazy imports can still need those files. Compatible process reattachment avoids a process cold start, not an interruption of execution authority.

The process-backed Gateway transcript verifies that accepted work completes after a release mismatch, Admin start reports the pending upgrade, and an explicit administrative stop remains effective. PostgreSQL tests retain the original bearer during pending upgrade and reject it after account revocation. These checks do not prove uninterrupted managed execution across a real Gateway shutdown and authorization-stream loss.
