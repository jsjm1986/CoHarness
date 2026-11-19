# Agent Note: Device-reported push delivery outcome receipts

Status: implemented

English | [中文](2026-11-19-push-delivery-outcome-receipts.zh.md)

## Problem

`push_deliveries.status = 'sent'` recorded only provider acceptance — the JPush or FCM HTTP API acknowledged the request — never device arrival or user interaction. Operators could not distinguish a notification that reached the handset from one the vendor channel dropped after acceptance, and neither users nor administrators had any read surface over registered devices or recent deliveries.

## Decision

Extend [push delivery authority](../bug-fix/2026-10-29-push-delivery-authority.md) with device-reported outcomes, keeping the existing claim/fence model unchanged:

- Migration adds `provider_msg_id`, `delivered_at`, `opened_at` to `harness.push_deliveries`. Senders return the provider's message id (JPush `msg_id`, FCM `name`) which `notifyCompleted` persists alongside the `sent` claim for correlation.
- `POST /account/api/push-receipts` accepts `{provider, token, sessionId, eventSeq, kind}` where `kind` is `arrived` or `opened`. `recordReceipt` revalidates the active account, resolves the owned device by organization, provider, token and user, then stamps the matching delivery: `arrived` sets `delivered_at`; `opened` sets `opened_at` and backfills `delivered_at`. Repeated receipts for the same delivery are idempotent; unowned or unknown targets return `missing` → HTTP 404.
- `GET /account/api/push-devices` lists the authenticated account's devices with each device's latest delivery; `GET /admin/api/push/overview` returns all organization devices, the 200 most recent deliveries, and status/provider aggregate counts.
- The Android shell reports both signals from `CoHarnessPushReceiver`: `onNotifyMessageArrived` posts `arrived`, `onNotifyMessageOpened` posts `opened` before the existing [runtimeId click bridge](../bug-fix/2026-11-19-android-push-bridge-runtimeid-contract.md). `PushReceiptReporter` sends on a background thread with the WebView `CookieManager` session cookie against `BuildConfig.PUSH_GATEWAY_ORIGIN` (injected from `DSH_ANDROID_WEB_URL`); malformed extras, missing or nonnumeric `eventSeq`, and empty tokens drop silently.
- `NativePushStatusPlugin.getPushStatus()` exposes provider configuration, JPush consent/initialization, the system notification toggle, and the JPush registration id to the wrapped web app via `getNativePushStatus()` in `apps/web/src/native-push.ts`.

## Consequences

- `sent` now means exactly provider acceptance; `delivered_at` and `opened_at` are the only device-truth signals. A delivery can legitimately stay `sent`-without-`delivered_at` forever (killed vendor channel, offline device, unconfigured JPush).
- Receipt reporting is best-effort and non-blocking: transport failure, missing session cookie, or an unsigned-in WebView loses that receipt without affecting notification display or click routing. No retry/outbox is added, matching the shell's documented append window.
- Diagnostic builds (`NATIVE_PUSH_ENABLED=false`) never report receipts and `getPushStatus` reports unconfigured.
- Only JPush produces receipts today; the FCM path registers devices but has no native arrival/open callback wired, so FCM deliveries never advance past `sent` until one is added.

## Alternatives considered

- **Trust provider server-side receipt callbacks** — rejected for arrival truth: JPush delivery receipts require separate callback infrastructure and still cannot observe the open event, which only the device knows.
- **Report through the web app over its authenticated fetch** — rejected: the WebView may be dead or on a stale page when the notification arrives; only the native receiver is guaranteed to run.
- **Queue receipts for retry** — rejected: adds a durable outbox for diagnostic telemetry that is already idempotent server-side; the next notification's receipt re-observes the same device state.

## Verification

- `gateway/tests/server.spec.ts` + `push-notifications-postgres.spec.ts` — 159/159 pass, covering receipt idempotency, `arrived`/`opened` timestamp semantics, per-account device isolation, admin aggregation, foreign-token rejection, and unknown-target 404.
- `NativePushBridgeTest` instrumentation covers arrival and open payloads (provider/token/sessionId/eventSeq/kind) plus malformed JSON, absent sequence, and nonnumeric sequence rejection.
- `./gradlew :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug` — BUILD SUCCESSFUL.
