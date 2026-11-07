# Agent Note: Systemd control clients have bounded owned lifetimes

Status: implemented

English | [中文](2026-10-25-systemd-control-command-ownership.zh.md)

## Problem

A stalled systemctl client can hold Runtime startup, liveness or termination indefinitely. Caller cancellation cannot close a client that never received its signal, and ordinary environment inheritance exposes deployment credentials to host helper programs. Client termination also cannot establish whether systemd accepted the underlying service job.

## Decision

Gateway native systemctl clients use the validated `HGW_SYSTEMD_COMMAND_TIMEOUT_MS` deadline, defaulting to 120000 milliseconds. Startup passes its cancellation signal through daemon reload and restart; cancellation observed after grant preparation prevents unit publication. Native command execution filters Gateway and credential environment variables, uses the C locale for machine-readable diagnostics, disables systemctl password prompts and pagers, and awaits the child's native close event on success or failure. Cancellation force-kills clients that ignore SIGTERM; its abort subscription remains owned until close. The explicit abort owner signals only an assigned child PID; Node’s built-in AbortSignal spawning path is excluded for the [failed-allocation cancellation reason](2026-10-29-native-command-cancellation.md). Tunnel discovery and extraction share this command owner.

Systemd Runtime startup verifies the configured Unix account before credential publication and process admission. Account provisioning remains an operator task; a missing account is reported directly rather than entering an avoidable service-start and cleanup cycle. This native lookup shares the bounded command owner and does not change service-generation termination evidence.

Project-profile preparation and privileged document publication use the same native command owner for UID/GID lookup, with `HGW_READINESS_TIMEOUT_MS` as the per-query deadline. Both queries close before cancellation or a lookup failure returns; the Gateway event loop remains available while the system identity service waits. These administrative queries do not recursively acquire a workload permit. Each caller retains its existing startup or document-initialization ownership.

The Linux subprocess provider independently bounds synchronous probes, state queries, signal commands and empty-unit retirement to five seconds. Timeout uses SIGKILL to close native clients, including those ignoring SIGTERM; asynchronous queries join native closure and blocking calls return after their client ends. A failed query keeps managed-range ownership unknown and cannot acknowledge task termination or release reservations. This deadline does not limit target task execution.

The service generation remains independently owned. A restart failure returns `RuntimeLaunchCleanupError` with its exact generation handle, because killing the CLI cannot cancel an acknowledged or uncertain systemd job. Stop masks the generation before its bounded reload and stop commands. Failed stop or liveness commands retain uncertainty; only inactive or missing-unit evidence uses exit codes 3 or 4. [Runtime admission](../architecture/2026-10-23-gateway-runtime-admission.md) retains reservations until service termination is confirmed, and [local supervision](../architecture/2026-10-25-local-runtime-supervisor.md) separately owns POSIX Runtime groups.

Generation units use `Type=exec` so restart acknowledgement follows credential loading and executable setup. Their owner-private credential source is named by Runtime, generation and bearer fingerprint, retained through automatic restarts and Gateway replacement, and removed only after the masked generation confirms stopped. Failed or uncertain stops retain the source; an older handle cannot remove a replacement generation's credentials.

## Alternatives considered

**Race the command promise against a timer.** Rejected because returning while its child remains alive loses control-command ownership.

**Release Runtime admission when the CLI exits.** Rejected because the service manager owns the Runtime independently; the CLI's closure establishes only its own termination.

## Consequences

Administrative control commands have finite waits and do not consume a model user's execution quota. An unavailable service manager can still prevent confirmed cleanup and retain a Runtime reservation. Operators can increase the deadline for slow service operations. Native fixture clients verify cancellation, timeout, listener closure and environment filtering without contacting a host system manager; these checks do not establish Linux service or cgroup containment behavior.
