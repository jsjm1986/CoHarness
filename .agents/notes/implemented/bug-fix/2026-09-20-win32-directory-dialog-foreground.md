# Agent Note: Win32 directory dialog foreground activation

Status: implemented

English | [中文](2026-09-20-win32-directory-dialog-foreground.zh.md)

## Problem

Upstream `dsh-v0.1.6-alpha.2` fixes a real defect this fork shares: a folder dialog spawned by a background web host opens behind every other window on Windows. Windows grants foreground activation only to the foreground process, a process it started, or a process that received recent input — a picker worker qualifies for none.

## Decision

Port the upstream mitigation. `win32-dialog-bindings` binds `user32!keybd_event` and exposes `pressAltForForeground`, which synthesizes one Alt press (down, then up) immediately before `Show`, counting the worker as the most recent input owner. The technique is community-documented with no formal contract, so the binding documents it as best-effort: it can fail on secure desktops or restricted remote sessions, and a foreground-privileged caller (a console-launched CLI) receives an inert lone Alt that may briefly highlight the focused window's menu bar.

## Alternatives considered

**Set the dialog owner to the shell window or call `SetForegroundWindow` after `Show`.** Rejected: both still need an activation grant the worker does not have; the Alt press is the only step that manufactures the grant itself.

**Attach the dialog to the browser window via `AttachThreadInput`.** Rejected: cross-process input attachment is more invasive than a same-process synthetic key and the web host has no stable window handle to donate.

## Consequences

The worker picks up the foreground grant on ordinary desktops; nothing else in the COM/dialog lifecycle changes. Callers do not observe the grant attempt — failure degrades to the previous behind-window behavior rather than a new error.

## Testing

`pnpm exec vitest run packages/host/directory-picker-native` — 47 passed, 1 skipped, including the `keybd_event` binding contract, the `pressAltForForeground` call ordering before `Show` in the logic spec, and the capability probe in the win32 dialog spec.
