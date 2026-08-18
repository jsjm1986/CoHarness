# Android shell

English | [中文](README.zh.md)

This directory contains the CoHarness Capacitor Android shell that loads the hosted Web UI. The default deployment URL is `https://harness.maycran.com/`; override it with `DSH_ANDROID_WEB_URL` when building another environment.

## First setup

```sh
cd apps/android-shell
pnpm install
DSH_ANDROID_WEB_URL=https://harness.maycran.com/ pnpm run build
pnpm run cap:add
DSH_ANDROID_WEB_URL=https://harness.maycran.com/ pnpm run cap:sync
```

Place the `google-services.json` downloaded from the Firebase console at `android/app/google-services.json`. Do not commit a server-side Firebase service-account JSON file. Then run:

```sh
cd android
./gradlew assembleDebug
```

## Later releases

Ordinary Web UI changes only require publishing the Web assets; they do not require rebuilding the APK. Resync and rebuild the Android project when native Android plugins, permissions, the package name, icons, or notification handling change.

The custom CoHarness launcher and splash artwork is kept in `branding/`. Android uses the matching adaptive foreground/background resources, branded splash variants, and `ic_stat_harness` as the monochrome notification icon.

The Gateway must set `HGW_FCM_PROJECT_ID` and `HGW_FCM_SERVICE_ACCOUNT_FILE` before it can send FCM messages. Keep the server credential in a permission-restricted file on the Gateway host.
