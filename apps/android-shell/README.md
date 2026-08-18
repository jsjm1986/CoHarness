# Android shell

English | [中文](README.zh.md)

This directory contains the CoHarness Capacitor Android shell that loads the hosted Web UI. The default deployment URL is `https://harness.maycran.com/`; override it with `DSH_ANDROID_WEB_URL` when building another environment.

The Android application id is `com.coharness`. Register this exact id with Firebase and any Android vendor push console.

## First setup

```sh
cd apps/android-shell
pnpm install
DSH_ANDROID_WEB_URL=https://harness.maycran.com/ pnpm run build
pnpm run cap:add
DSH_ANDROID_WEB_URL=https://harness.maycran.com/ pnpm run cap:sync
```

Place the `google-services.json` downloaded from the Firebase console at `android/app/google-services.json` when FCM is enabled. Do not commit a server-side Firebase service-account JSON file. Then run:

```sh
cd android
./gradlew assembleDebug
```

## Later releases

Ordinary Web UI changes only require publishing the Web assets; they do not require rebuilding the APK. Resync and rebuild the Android project when native Android plugins, permissions, the package name, icons, or notification handling change.

The custom CoHarness launcher and splash artwork is kept in `branding/`. Android uses the matching adaptive foreground/background resources, branded splash variants, and `ic_stat_harness` as the monochrome notification icon.

The Gateway must set `HGW_FCM_PROJECT_ID` and `HGW_FCM_SERVICE_ACCOUNT_FILE` before it can send FCM messages. Keep the server credential in a permission-restricted file on the Gateway host.

## Push providers

JPush is enabled by default in the native module (`cn.jiguang.sdk:jpush:6.2.0`). Set `JPUSH_APPKEY` through a Gradle property or environment variable; the Android package id registered in JPush must be `com.coharness`. The shell initializes JPush only after Android notification permission is granted, then remembers that consent for later launches. The Gateway sends JPush notifications when `HGW_JPUSH_APP_KEY` and `HGW_JPUSH_MASTER_SECRET` are both set. JPush-only builds do not need `google-services.json`.

Optional vendor plugins are controlled by `JPUSH_ENABLE_HUAWEI`, `JPUSH_ENABLE_FCM`, `JPUSH_ENABLE_XIAOMI`, `JPUSH_ENABLE_OPPO`, `JPUSH_ENABLE_VIVO`, `JPUSH_ENABLE_MEIZU`, and `JPUSH_ENABLE_HONOR`. Huawei builds also require `android/app/agconnect-services.json`; FCM builds require `android/app/google-services.json`. The FCM client version defaults to `25.1.1` and can be overridden with `FCM_MESSAGING_VERSION` when a vendor compatibility matrix requires another release. Keep AppKeys, secrets, Firebase service-account JSON, and vendor configuration files outside Git.
