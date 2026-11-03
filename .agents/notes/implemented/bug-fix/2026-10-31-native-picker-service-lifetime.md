# Agent Note: Native chooser service lifetime

Status: implemented

English | [中文](2026-10-31-native-picker-service-lifetime.zh.md)

## Problem

Withdrawing a native picker service does not by itself cancel commands that it has already started. A captured capability can also outlive service registration. Without an operation owner, unload can leave a chooser running and an old capability can allocate another helper.

## Decision

Each native provider instance owns one abort controller and its pending pick promises. Picks combine caller cancellation with provider lifetime before dispatch. Disposal aborts the provider and waits for accepted promises; completed picks remove themselves. An aborted lifetime refuses subsequent calls through the same stable capability object.

The [native command runner](2026-10-29-native-command-cancellation.md) retains POSIX helpers through process and stream closure. Provider ownership supplies the missing unload cancellation without changing that runner's separate role or the [client settlement fence](2026-09-16-native-picker-stale-settlement-fence.md).

## Alternatives considered

**Only remove service registration.** Consumers may still await a command started before withdrawal or hold the stable capability object.

**Cancel only the caller.** A live connection does not end when its native backend unloads. Cancelling a provider must also leave independent callers and provider instances unaffected.

**Abort without awaiting completion.** A cancellation signal does not establish that the accepted operation has finished releasing its resources.

## Consequences

Provider and enclosing Host teardown drain accepted native pick operations. Caller cancellation keeps a live provider usable. POSIX runnable compositions check actual helper absence after teardown and rejection through retained capabilities; controlled completion checks that unload remains pending until the helper finishes. Windows native process retirement requires its separate driver and platform acceptance.
