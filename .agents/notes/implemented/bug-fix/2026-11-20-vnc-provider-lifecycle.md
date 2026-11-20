# Agent Note: VNC provider owns startup and connection teardown

Status: implemented

English | [中文](2026-11-20-vnc-provider-lifecycle.zh.md)

## Problem

A VNC provider could become visible while its private files were still loading. Its shutdown stopped established pumps but could leave an admitted dial, credential handshake, recording, or audit append in progress.

## Decision

Cordis readiness waits for the grant store, audit log, and configured endpoints. Disposal closes operation admission, clears attach tokens, cancels dialing, and closes both ends of owned transports. A dial that returns after cancellation is closed before forwarding. The provider joins accepted operations and recording closure before it drains the audit log.

## Alternatives considered

**Close established transports during disposal.** An admitted dial or credential handshake can still complete after that cleanup. Joining accepted operations keeps their transports and final audit writes within the provider's lifetime.

## Consequences

An unreadable private store fails the plugin’s startup. Grant mutations admitted before withdrawal can settle and record their audit events. A caller retaining the withdrawn service receives `REMOTE_DESKTOP_TARGET_UNAVAILABLE` on new operations.

## Verification

The real Loader composition covers failed and interrupted store initialization. The lifecycle tests hold dialing, credential resolution, and audit appends open during disposal and verify that the provider waits for each owner.
