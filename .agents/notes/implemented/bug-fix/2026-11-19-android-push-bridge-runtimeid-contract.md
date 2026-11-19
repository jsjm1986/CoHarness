# Agent Note: Android push bridge requires the runtimeId intent extra

Status: implemented

English | [中文](2026-11-19-android-push-bridge-runtimeid-contract.zh.md)

## Problem

`NativePushBridgeTest` failed on the `android / native bridge` CI lane with three distinct signatures — a null `observed` payload from the real-activity path, `expected:<notificationAction> but was:<null>`, and a `NullPointerException` on `listener.payload`. All three traced to the same root: the instrumentation built launch intents carrying `coharness.sessionId` (and `coharness.eventSeq`) but no `coharness.runtimeId`, and `NativePushStatusPlugin.handleNotificationIntent` drops any intent whose runtimeId is null. The lane never runs on pull requests — it is `workflow_dispatch`-only — so the stale tests sat unnoticed until a manual audit surfaced them.

## Decision

The production contract requires runtimeId and the tests now match it: `CoHarnessPushReceiver` only emits intents with a sessionId plus a UUID-validated runtimeId, and the web side (`apps/web/src/native-push.ts` `openNotificationSession`) rejects the payload unless runtimeId matches the UUID pattern. Every intent in `NativePushBridgeTest` now carries a runtimeId, the observed payload asserts it alongside sessionId and eventSeq, and the cold-start test also verifies the runtimeId extra is consumed after delivery. `handleNotificationIntent` additionally rejects a blank-but-present runtimeId — previously it only null-checked, so an empty-string runtimeId delivered an empty field; the guard is now symmetric with sessionId.

## Alternatives considered

- **Relax the plugin to allow missing runtimeId**: rejected — the receiver, the web listener, and the session-routing key (`dsh.sessions.current.v2.{runtimeId}`) all treat runtimeId as mandatory; a null-tolerant plugin would deliver payloads the web side immediately discards, hiding misconfiguration.
- **Update only the tests**: rejected for the blank-runtimeId gap — an empty-string extra is malformed input the plugin should drop rather than forward; the symmetric guard costs one clause.

## Consequences

The bridge lane's three instrumentation tests now prove the real contract end to end instead of an impossible intent shape. A malformed intent carrying a blank runtimeId no longer notifies listeners. The runtimeId format itself stays enforced upstream (receiver UUID check, web UUID check) — the plugin deliberately keeps the lighter non-blank guard rather than duplicating the regex.

## Verification

- `./gradlew :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug` — BUILD SUCCESSFUL.
- `android / native bridge` CI lane on this branch (workflow_dispatch `suite=android-audit`) — the three `NativePushBridgeTest` cases pass against the real Capacitor listener.
