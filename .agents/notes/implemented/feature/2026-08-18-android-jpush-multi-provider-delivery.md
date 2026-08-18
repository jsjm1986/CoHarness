# Agent Note: Android JPush multi-provider delivery

Status: implemented

English | [中文](2026-08-18-android-jpush-multi-provider-delivery.zh.md)

## Problem

Android devices in the target deployment do not share one reliable push transport. The existing Capacitor shell already supports FCM, but domestic devices need JPush and optional vendor channels without creating a second application package or exposing reply content in an unauthenticated notification surface.

## Decision

The Android shell keeps the `com.coharness` application id and adds JPush `6.2.0` as the base native provider. Huawei, FCM, Xiaomi, OPPO, vivo, Meizu, and Honor integrations are optional Gradle dependencies controlled by explicit `JPUSH_ENABLE_*` properties. Huawei and FCM client configuration files are build inputs and remain outside the repository.

The Web UI registers FCM tokens through `/account/api/push-devices` and registers a JPush RegistrationID through the same endpoint with `provider: "jpush"`. The native shell initializes JPush only after Android notification permission is granted and restores that consent on later main-process launches. PostgreSQL stores the provider and enforces uniqueness on `(organization_id, provider, token)`; requests without a provider retain the FCM default for older clients.

The Gateway constructs one sender per provider. FCM uses its existing HTTP v1 service-account flow; JPush uses the REST `/v3/push` endpoint with Basic authentication from `HGW_JPUSH_APP_KEY` and `HGW_JPUSH_MASTER_SECRET`. The two JPush variables are validated as a pair during configuration loading. Invalid provider registrations are rejected at the account API, and provider-specific invalid registrations are removed after a failed send.

The native shell does not call Firebase registration when no Firebase client configuration is present, so a JPush-only build can initialize without FCM credentials. JPush notification clicks carry only the session id and event sequence. The receiver forwards both cold-start and warm-start intents to the Capacitor plugin, which retains the event until the Web listener opens the authenticated session.

## Alternatives considered

**Replace FCM with JPush for every Android build.** Rejected because FCM remains useful on devices with Google Play services and existing registrations must continue to work.

**Implement each domestic vendor SDK directly in the Gateway.** Rejected because JPush already normalizes vendor registration and delivery, while the Gateway needs one provider sender and one device registry.

**Keep provider out of the device row and infer it from the token.** Rejected because FCM tokens and JPush RegistrationIDs have different lifecycles and can coexist on one account; provider-aware uniqueness and routing are explicit.

**Put the reply body in the notification.** Rejected because notification content can be visible outside the authenticated Web UI; the session pointer remains the only payload.

## Consequences

JPush-only deployments do not need `google-services.json`; FCM and Huawei still require their respective console files. The Gateway host must protect JPush and Firebase server credentials, and operators must enable only the vendor channels for which console credentials exist. Provider-aware migration 010 is required before existing device rows can be registered or delivered with the new routing key.

The shell remains a thin remote Web wrapper, so ordinary Web UI releases do not require an APK rebuild. Native provider, permission, package, icon, or click-handling changes still require Capacitor synchronization and a new build. Notifications remain creator-scoped hints rather than a second transcript.

## Verification

Gateway typecheck and focused configuration, HTTP, sender, and delivery tests pass. Android `:app:assembleDebug` passes with the repository's Gradle wrapper and OpenJDK 21; the build emits upstream JPush D8 stack-map warnings and native-library strip warnings but produces a `com.coharness` APK. Real device delivery still requires deployment credentials and at least one registered JPush or vendor application.
