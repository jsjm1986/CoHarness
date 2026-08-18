# Agent Note: Android remote Web shell and FCM completion notifications

Status: implemented

English | [中文](2026-08-17-android-remote-web-fcm-notifications.zh.md)

The JPush and domestic-channel extension is recorded in [Android JPush multi-provider delivery](2026-08-18-android-jpush-multi-provider-delivery.md).

## Problem

The Web UI needs a simple Android installation path and a phone notification when an AI reply finishes. Rebuilding an APK for every Web UI change would make the wrapper expensive to operate, while sending complete replies through a mobile notification would expose conversation content outside the authenticated UI.

## Decision

The Android application is a Capacitor shell whose `server.url` points at the deployed HTTPS Web UI. The shell contains only the native project and push capability; ordinary Web UI releases remain server-side and do not require an APK rebuild. The application id is fixed at `com.coharness`; changing it creates a new Android package and requires a new Firebase client registration. A new native plugin, permission, icon, or notification-handling behavior requires `cap sync` and a new build.

The shell remains a private workspace application rather than an npm release member. The root workspace includes it for dependency resolution and local commands, while release discovery and npm baseline packing exclude `apps/android-shell`.

The Web UI registers an Android FCM token after the authenticated user grants notification permission and stores it through `/account/api/push-devices`; the later JPush extension uses the same route with a provider tag. PostgreSQL records organization, user, provider, token, platform, and device metadata. A registration is unique within an organization and provider, and deletion requires the owning authenticated user. Firebase service-account JSON stays on the Gateway host and is never committed or sent to the Web client.

The Gateway notifies only the conversation creator's registered devices. It schedules a notification after a conversation append returns `inserted` and the appended events contain `turn/end` with `data.reason.kind === 'completed'`; duplicate appends and non-completed endings do not schedule a second notification. The payload contains only the session id and event sequence, so the app opens the existing authenticated Web UI instead of placing reply text in the notification.

`push_deliveries` records one delivery key per organization, session, event sequence, and device. A sent record is not claimed again, and a provider response identifying an invalid registration removes that registration. The first implementation sends asynchronously after persistence and logs failures; it does not add a background outbox worker, so a process exit between the append and the send can lose a notification without losing the conversation.

## Alternatives considered

**Rebuild the complete chat UI as a native Android application.** Rejected because it duplicates the Web client and would make every UI change a mobile release.

**Bundle a local Web build inside the APK.** Rejected because every Web release would require a new APK and the shell would not immediately receive server fixes.

**Poll the Gateway from the phone.** Rejected because it consumes battery and requires foreground or periodic background scheduling; FCM already supplies the delivery channel.

**Include the assistant reply in the notification.** Rejected because notification surfaces can be visible outside the authenticated application and the reply may contain sensitive project data.

**Build a durable notification outbox worker in the first release.** Deferred because the append path already has delivery idempotency and the simple deployment needs no additional worker process; the crash window is recorded explicitly for a later reliability decision.

## Consequences

The Android package stays small and stable while Web UI deployments remain independent. Users must grant Android notification permission, and the Gateway deployment provides the credentials for whichever push providers are enabled. Notifications are creator-scoped rather than broadcast to every project member, and they are hints that open the authoritative conversation history.

## Verification

Gateway unit tests cover FCM request fields, token registration and ownership checks, delivery idempotency, invalid-token removal, configuration, HTTP authentication, and completed-event filtering. PostgreSQL integration tests assert migration 008 and both push tables when `HGW_TEST_DATABASE_URL` is configured. The Android shell fallback build and Capacitor project generation run without Firebase credentials; release assembly additionally requires the deployment's client configuration files and a Java/Android SDK toolchain.
