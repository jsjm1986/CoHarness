---
kind: upgrade-guide
description: "Managed Runtime automatic idle release requires an explicit on-demand policy and authenticated background-work confirmation."
---

# Managed Runtime idle policy

English | [中文](guide.zh.md)

## Change

Managed Runtimes default to retaining an already-running process. `HGW_IDLE_TIMEOUT_MS` applies only to explicitly on-demand Runtimes after authenticated Host checks and atomic resource checks succeed. Older or unavailable Hosts remain running. This prevents background and scheduled work from being stopped after browsers disconnect.

## Migration

1. Keep each Runtime with scheduled tasks, listeners or unadapted custom plugins in the default resident mode. Timers require the original Host process to remain running; no process-external scheduled startup is supplied.
2. For a compatible Runtime, use its existing settings provider to set `runtime-execution.mode` to `on-demand`. The same section in its own `settings.yaml` is `runtime-execution: { mode: on-demand }`. Project writes require the existing project-manager authority. Use `resident` to retain the process.
3. Custom plugins with pending or future work register a synchronous global `runtime/idle-release-check` listener returning `busy` until execution and cleanup settle. Reuse existing exact-Agent resource checks where applicable. Jobs with forced-failed records still retain their raw producer resource acknowledgment; a rejected acknowledgment or failed cleanup blocks automatic idle release and requires existing administrative control to address the uncertainty.
4. Apply upgrades without interrupting running tasks. A Gateway that reattaches without the original challenge credential retains that process; a later authorized restart restores ordinary idle probing.
5. Verify that disconnecting browsers leaves active timers and long tasks running. An explicitly on-demand Runtime becomes eligible only after its work and future obligations end and the configured idle period passes. Reading computer directories must not start unused Runtimes.

See the [Runtime settings and lifecycle reference](../../../../packages/context/gateway-runtime/README.md).
