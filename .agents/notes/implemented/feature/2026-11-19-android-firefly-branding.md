# Agent Note: Android launcher and splash artwork use the firefly brand mark

Status: implemented

English | [中文](2026-11-19-android-firefly-branding.zh.md)

## Problem

The Android shell's launcher icon and splash screens carried a generic circuit-hexagon mark that was invented for the shell, not the product's actual logo. It shared no identity with the two marks the project really uses — the firefly from `website/public/favicon.svg` and the simple arc-and-dot mark from `apps/web/public/favicon.svg` — so installed builds were visually unbranded.

## Decision

`apps/android-shell/branding/` now carries the firefly mark as the single source for launcher and splash artwork. The three icon SVGs (`app-icon.svg`, `app-icon-round.svg`, `app-icon-foreground.svg`) keep the existing navy gradient, corner circuit accents, and adaptive-icon layering, but center a dark-scheme-baked firefly glyph: the favicon's light/dark media queries are flattened to the dark palette, the antennae stroke is raised from 1.9 to 2.8 so it survives mdpi rasterization, and the center glow is retinted from teal to the lantern blue (`#4F7CFF`). Both splash SVGs swap the hexagon group for the same glyph at centered scale. The 26 generated PNGs under `android/app/src/main/res/` were re-rendered from these sources (5 launcher densities × icon/round/foreground, 11 splash sizes) and ship in the debug APK — verified inside `app-debug.apk` under `res/mipmap-xxxhdpi-v4/`.

## Alternatives considered

- **Simple arc-and-dot mark** (`apps/web/public/favicon.svg`): loses to the firefly on distinctiveness — at 48dp it reads as a generic glyph shared with no other surface, while the firefly is already the documentation site's identity and survives downscaling recognizably.
- **Embedding the favicon verbatim**: rejected because its `prefers-color-scheme` media queries leave colors unresolved in a static rasterization context, and the 1.9-unit antennae would dither out at mdpi; the baked dark variant with the thicker stroke is the same mark, renderable.
- **Keeping the hexagon for the splash only**: rejected for consistency — a mixed identity (hexagon splash over a firefly icon) is worse than either single choice.

## Consequences

Launcher and splash surfaces now carry the same brand mark as the documentation site. The trade-off accepted: the firefly's thin wing strokes and accent dots lose some subtlety at mdpi (48px), which the thicker antennae and high-contrast body/wing fills compensate for. Release-signed APKs remain unconfigured; this change only affects debug-buildable assets.

## Verification

- `./gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest :app:assembleDebugAndroidTest` — BUILD SUCCESSFUL on JDK 21.
- `aapt2 dump badging` on `app-debug.apk` confirms `com.coharness`; the packaged `res/mipmap-xxxhdpi-v4/ic_launcher.png` renders the firefly glyph on the navy squircle.
