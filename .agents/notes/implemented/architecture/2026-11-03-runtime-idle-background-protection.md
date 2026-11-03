# Agent Note: Runtime idle release preserves background work

Status: implemented

English | [中文](2026-11-03-runtime-idle-background-protection.zh.md)

## Problem

A managed Host can own scheduled reminders, background memory passes and long-running plugin work after every browser disconnects. HTTP activity and WebSocket references alone cannot prove that its process is idle. Releasing a Session Agent is also different from stopping the Host that owns its plugins and timers.

## Decision

Automatic process release requires an explicit per-Runtime on-demand policy and a fresh authenticated Host decision. Resident is the compatibility default because arbitrary existing plugins may own work that the supervisor cannot inspect. Policy uses the existing Runtime settings provider and project-manager authorization rather than a second configuration store.

Plugins own their declarations through `runtime/idle-release-check`. The Host also consults exact-Agent resource checks; the loop reports maintenance and pending input despite their public idle status. Schedule retains the process for active durable tasks and accepted management or delivery work. Memory retains its running passes through cleanup. These declarations inform automatic release without changing explicit shutdown or authorization revocation.

The idle decision has its own HMAC over the challenge, owner, generation, policy and result. The Gateway retains unavailable or unsupported Hosts and binds termination to the confirmed generation. It keeps challenge credentials only with the process handle in memory. A recovered process without that credential remains protected instead of gaining an inferred idle result.

PostgreSQL claims idle termination under the same node-resource lock used by admission, followed by the instance lock. The claim rechecks activity and generation and refuses queued, active and uncertain reservations. New execution either reserves first and prevents stopping, or sees the stopping state and cannot begin. This extends the [activity admission decision](2026-11-01-atomic-runtime-activity-admission.md) without replacing its current-permission checks.

Holder-owned workflow vetoes belong to the application root, so engine unloading preserves them until the run and child cleanup settle. Jobs retain root-owned Runtime and exact-Agent declarations through the provider fiber's completed unload; Loader removal may delete its entry before that cleanup finishes. Schedule retains its declaration through domain close.

Jobs also retain producer resource ownership separately from registry records. Forced failure after a throwing teardown cancellation permits provider removal while the raw producer acknowledgment remains pending. Root-owned Runtime and exact-Agent declarations survive until the producer confirms resource release and its output drain completes. Rejected acknowledgments or failed cleanup remain uncertain and block automatic release.

## Alternatives considered

**Use connection counts or public Agent status.** Neither represents waiting timers, post-turn memory work, maintenance or native cleanup. Exact plugin ownership remains necessary.

**Enable on-demand for every existing plugin.** Unadapted listeners and timers have no declaration, so absence of a busy response cannot establish their safety. Existing compositions default to resident.

**Move scheduling into the Gateway.** The Schedule plugin owns recurrence, Session binding and durable delivery. Preserving its running Host provides safety without introducing another scheduler or changing missed-delivery semantics. Stopping between scheduled occurrences requires a separate durable wake capability.

**Combine locking and checking in one statement.** A statement can take its snapshot before waiting for the node lock. A reservation committed during that wait must be visible to the idle decision, so the conditional update uses a fresh statement after acquiring the lock.

**Wait indefinitely for a broken producer during provider removal.** Registry force-failure preserves nonblocking teardown when cancellation throws. Independent root ownership retains the uncertain work for idle checks without changing that removal behavior.

## Consequences

An activated resident Runtime retains its process until an explicit stop, failure or existing authority-convergence path. Unused environments still start only on actual demand. More processes can remain resident than under connection-only reaping, so existing node limits continue to govern admission; no resource-saving percentage is assumed.

A timer wakes its original Session Agent inside a running Host. It does not start a stopped process, and resident policy does not automatically start a computer or restore stopped environments. Deployment must preserve running work instead of using restarts to apply this policy.

Real Loader, settings-file, persistence and HTTP scenarios cover resident defaults, on-demand changes, maintenance and future schedules with no active Session. Native managed-process cases cover signed and unsupported idle decisions. PostgreSQL cases cover outstanding reservations, newer activity, generation changes and competing admission. Session identity, files, drafts, model permissions and tab selection retain their existing owners.
