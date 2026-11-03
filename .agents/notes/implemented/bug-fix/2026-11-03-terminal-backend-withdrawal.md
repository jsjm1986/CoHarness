# Agent Note: Join unpublished terminal setup when its backend leaves

Status: implemented

English | [中文](2026-11-03-terminal-backend-withdrawal.zh.md)

## Problem

A backend registration can leave while its asynchronous terminal setup still owns a native PTY. Removing only its type from the registry allows that setup to publish after its plugin stopped and gives the plugin no way to await rollback.

## Decision

Each [registration](../../../../packages/terminal/terminal/src/index.ts) owns a cancellation controller and its unpublished spawn records. Withdrawal removes only that exact contribution, cancels its setup with `NO_BACKEND` and joins settlement and rollback. The returned disposer is awaitable and reports rollback failure; concurrent plugin and explicit withdrawal callers join the same work. An unsuccessful rollback remains tracked owner activity until owner or service cleanup consumes and reports it.

Published sessions retain their exact Agent owner through backend reloads. A replacement contribution has independent cancellation, and owner-local names remain reserved until the previous setup settles. Caller cancellation retains its original reason. Session removal can still refuse publication after setup finishes.

## Alternatives considered

**Remove only the backend type.** Pending setup could publish a terminal whose backend plugin has already stopped.

**Close every published terminal on backend reload.** It would discard persistent sessions whose lifetime belongs to the Agent.

**Wait for setup without cancelling it.** Cooperative providers would receive no signal to release unpublished resources.

## Consequences

Consumers awaiting explicit backend withdrawal must await its returned promise. Disposal waits for a provider to settle rather than abandoning its native work. A provider must report cleanup uncertainty through its existing error paths. Whole-Host crashes and platform process containment remain subprocess responsibilities.

## Verification

The real Loader [example](../../../../packages/terminal/terminal/tests/fixtures/backend-lifetime.mjs) holds a running Bash PTY before publication, withdraws its backend, observes cancellation and verifies that disposal joins physical process exit. Unit cases cover failed rollback, replacement admission, name reservations, published-session survival and removal during setup.
