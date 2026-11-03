# Agent Note: Native dialog worker closure

Status: implemented

English | [中文](2026-10-31-native-dialog-worker-closure.zh.md)

## Problem

A dialog result or accepted termination request can precede worker process exit. Returning at either point loses the remaining process owner. Asynchronous window-close preparation can also outlive the worker whose thread id it captured.

## Decision

The Win32 driver retains its first reported outcome until the child emits `close` and all started window-close calls settle. Cancellation retries graceful window closure and then requests `SIGKILL`; a failed request retains the operation and its observers, including graceful retries for a late `showing` notice. At most one window-close call runs at once. A termination error remains available in the abort error's cause chain. The driver removes its event subscriptions after closure and never releases its process reference while the child remains active.

A separate worker-lifetime signal ends on observed process exit, including closure after spawn failure. The window closer checks that signal before and after asynchronous binding preparation. This rejects window messages prepared for a worker already known to have exited; it does not establish native thread identity when exit has not yet been observed.

This completes worker ownership beneath the [provider lifetime](2026-10-31-native-picker-service-lifetime.md), while the [COM adapter](../feature/2026-08-02-win32-in-process-folder-dialog.md) owns dialog creation and release.

## Alternatives considered

**Return on the worker's result message.** The IPC message confirms a result, independently of process and stream closure.

**Treat a successful kill call as completed cleanup.** It confirms a request, not exit. A refused call cannot justify discarding the owner.

**Discard pending window-close calls.** Their delayed binding preparation can still send messages after the worker has exited.

## Consequences

Provider disposal can wait for native worker retirement through its accepted pick promise. Unconfirmed termination keeps that promise pending. Actual IPC children verify the result, refused-termination and delayed-close intervals; the public picker also checks its real native-surface failure worker. Native COM rendering, selection and Windows kernel termination remain platform acceptance work.
