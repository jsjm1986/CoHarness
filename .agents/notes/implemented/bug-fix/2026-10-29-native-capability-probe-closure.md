# Agent Note: Native capability probes retain their clients through closure

Status: implemented

English | [中文](2026-10-29-native-capability-probe-closure.zh.md)

## Problem

Functional sandbox probes run synchronously before selecting confinement. A native client that ignores SIGTERM can outlive a configured Node timeout indefinitely, blocking selection and the host event loop. The caller cannot treat a timeout request as completed ownership or as a usable enforcement result.

## Decision

The [local sandbox provider](../../../../packages/sandbox/sandbox-local/src/index.ts) and the [public Landlock probe](../../../../native/system/packages/entry/src/index.ts) use SIGKILL for their existing native command deadlines. Synchronous return follows client closure. Timeout makes the candidate unusable; the provider continues its declared runner chain and caches the completed verdict. Failure never authorizes unconfined target execution. Capability probes are infrastructure preparation, separate from the admitted target workload.

The [systemd client decision](2026-10-25-systemd-control-command-ownership.md) independently owns control commands and uncertain managed ranges. The [native release decision](../process/2026-08-06-in-repository-landlock-release.md) owns source and artifact publication. Neither client closure nor a probe failure proves that a managed task stopped or that a kernel enforces confinement.

## Alternatives considered

**Race a consuming promise against a timer.** A synchronous probe blocks that thread's timer, and reporting failure without closing the client abandons a live process.

**Assume the ordinary timeout signal closes every client.** A helper can ignore SIGTERM. The probe owns forced closure before it returns a verdict.

## Consequences

An unavailable confinement backend can refuse or fall through to the next declared candidate after its configured deadline. A cached unavailable verdict retains the provider's existing retry policy. These rules do not change runner arguments, denial classification or kernel enforcement criteria. POSIX real-client tests cover command closure; Windows and real Linux kernel acceptance retain their independent platform owners.
