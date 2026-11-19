# Agent Note: UnifiedPush provider via ntfy distributor

Status: implemented

English | [中文](2026-11-20-unifiedpush-ntfy-provider.zh.md)

## Problem

CoHarness push delivery required a commercial provider account: JPush needs an AppKey/Master Secret and FCM needs Firebase, which is unreachable on Chinese handsets without Google services. There was no free, open-source, self-hostable path that delivers task-completion notifications to the Android shell.

## Decision

Add `unifiedpush` as a third `PushProvider` using the [UnifiedPush](https://unifiedpush.org) protocol with an [ntfy](https://ntfy.sh) distributor, extending the existing [receipt pipeline](2026-11-19-push-delivery-outcome-receipts.md) and [runtimeId click bridge](../bug-fix/2026-11-19-android-push-bridge-runtimeid-contract.md) unchanged:

- The device token stored for provider `unifiedpush` is the distributor-issued endpoint URL, an HTTPS write-capability URL (`https://<ntfy-host>/up<token>`). `UnifiedPushEndpointSender` in `gateway/src/push-notifications.ts` POSTs `{title, body, runtimeId, sessionId, eventSeq}` JSON to that URL; provider acceptance on any 2xx, optional `id` from a JSON response becomes `provider_msg_id`, HTTP 400 maps to an invalid-token error for cleanup.
- Outbound endpoints are constrained by `HGW_UP_ENDPOINT_ALLOWLIST`, a comma-separated hostname allowlist parsed in `gateway/src/config.ts` (`upEndpointAllowlist`): the token must parse as a URL, use `https:`, and match an allowlisted host exactly or as a subdomain. Everything else is rejected as an invalid token before any network call — the sender never POSTs to arbitrary URLs, and the provider stays disabled without the variable.
- The Android shell embeds `org.unifiedpush.android:connector` (Gradle forces `tink-android` because the connector's JVM `tink` artifact collides at runtime). `CoHarnessPushService` extends `PushService` for the `org.unifiedpush.android.connector.PUSH_EVENT` intent action: `onNewEndpoint` persists the URL and forwards it to the web layer as a retained `unifiedPushEndpoint` plugin event; `onMessage` parses the payload, reports an `arrived` receipt, and posts a local `ai-replies` notification whose launch intent carries the same session/runtime/provider extras the click bridge consumes — the `opened` receipt fires inside `handleNotificationIntent` when `EXTRA_PUSH_PROVIDER` is `unifiedpush`. Malformed payloads and missing/nonnumeric `eventSeq` drop silently.
- `NativePushStatusPlugin.initializeUnifiedPush` resolves `tryUseCurrentOrDefaultDistributor` (needs an Activity for the system picker), then `UnifiedPush.register`; `getPushStatus` reports the acknowledged distributor and stored endpoint. `CoHarnessApplication` re-registers silently on cold start when a distributor was acknowledged.
- `apps/web/src/native-push.ts` registers stored and event-delivered endpoints under `provider: 'unifiedpush'`; shells too old to return a status never expose the method and take the previous behavior. Both "nothing configured" early returns now permit a status-capable shell so UnifiedPush works on devices with neither FCM nor JPush.

## Alternatives considered

- **WorkManager polling + local notifications**: zero external dependency, but ~15-minute granularity and further suppression under MIUI power management — acceptable only as a degraded fallback, not a delivery path.
- **Embedded foreground service polling ntfy directly (no distributor)**: one APK instead of two, but duplicates the connection work ntfy already does, adds a permanent foreground-service notification, and still dies under MIUI — the distributor process is strictly more resilient.
- **Xiaomi vendor channel directly**: real killed-process delivery on this device class, but requires a Xiaomi Open Platform account and per-OEM SDK work — the entire point was avoiding account registration; JPush aggregation remains the better commercial route if an account becomes available.

## Verification (Redmi K30 Ultra, ntfy F-Droid 1.25.2)

- Instrumentation registered with the real distributor: ntfy created the `up01yXfjZxSCdN` subscription for `com.coharness` and issued the endpoint.
- `curl POST https://ntfy.sh/up01yXfjZxSCdN` → ntfy forwarded `org.unifiedpush.android.connector.MESSAGE` → the connector passed plaintext to `onMessage` → a `ai-replies` notification "AI 回复完成" appeared ~1.2s after the POST; tapping it foregrounded `MainActivity` through the PendingIntent extras.
- `arrived` and `opened` receipts were proven through the instrumentation sink (`provider: unifiedpush`, endpoint token, numeric `eventSeq`); malformed JSON and missing runtimeId dropped with no receipt.
- MIUI hard limits measured, not assumed: with autostart permission off, `WakePathChecker` logged `Service/Provider/Broadcast Reject … callee=com.coharness … action=org.unifiedpush.android.connector.MESSAGE` and delivery died silently; enabling the MIUI autostart toggle for CoHarness made a `kill -9`'d process wake and post the notification ~2s after POST. `am force-stop` blocks all broadcasts by framework rule and cannot be worked around — the same limitation applies to every non-vendor channel.
- ntfy itself needs battery-optimization exemption and autostart for boot-survival; its foreground service keeps the WebSocket alive while running.

## Consequences

- Deployments opt in per ntfy host through `HGW_UP_ENDPOINT_ALLOWLIST`; the allowlist is also what keeps the capability URLs confined to trusted servers.
- Delivery survives ordinary process death only where the ROM permits cross-app broadcast wake (MIUI requires the user-visible autostart toggle); force-stop still kills the whole chain.
- WebView shells running an older web bundle cannot drive registration — the native methods exist but `setupNativePush` on the deployed site predates them; registration starts automatically once the site bundle ships this change.
