# Agent Note: Await native helper termination on cancellation

Status: implemented

English | [中文](2026-10-29-native-command-cancellation.zh.md)

## Problem

A native command's abort error can arrive while its helper process remains alive. A caller that treats rejection as completed cancellation can discard the only owner of an active chooser or host command. A helper that ignores SIGTERM makes this failure deterministic.

## Decision

The [native command runner](../../../../packages/util/native-command/src/runner.ts) owns the direct helper through its `close` event. Cancellation sends SIGKILL and retains the command promise until process termination and captured-stream closure. The abort subscription is removed at that same completion point. The runner owns cancellation directly instead of passing `signal` into Node’s `execFile`: before the failed-spawn error arrives, an unallocated native handle can address POSIX process group zero. Only a child with an assigned PID receives a signal. An already cancelled call allocates no process and retains the public `ABORT_ERR` code and empty captured streams.

Normal output and error fields retain their existing meanings. The runner remains a library for host integrations, outside Session model and process-workload admission. The [directory-picker capability](../architecture/2026-07-28-directory-picker-capability-seam.md) and desktop handoff keep their own interaction and application lifetimes.

## Alternatives considered

**Return when the abort callback fires.** The error describes cancellation intent without proving helper termination, so callers can lose cleanup ownership.

**Set only execFile's killSignal.** That option controls execFile's own termination paths but does not configure its underlying AbortSignal cancellation on the supported Node implementations.

**Own every application opened by the helper.** A desktop handoff deliberately transfers the selected application to the user's desktop. The temporary command remains owned; the handed-off application has an independent lifetime.

## Consequences

Cancellation waits for the helper to close before the caller can release its operation. An ignoring helper cannot retain the native command slot after cancellation returns. The public runner signature, output fields and error codes stay compatible. Native desktop and Windows termination acceptance remain platform-specific verification.

## Testing

A real POSIX child installs its SIGTERM handler before publishing readiness. The regression cancels it, checks the public abort error, and records that the process is absent before return. Teardown kills and reaps the fixture even on failure. Adapter tests emit the asynchronous callback and close events that the real execFile API supplies. The broader picker, path-opener and application-resolution tests retain their existing behavior.
