# Agent Note: noVNC MPL-2.0 distribution for the remote desktop client

Status: implemented

English | [中文](2026-10-19-novnc-mpl-distribution.zh.md)

## Problem

The human remote desktop client (`ui-remote-desktop`) needs an RFB (VNC) renderer inside the browser tab. `@novnc/novnc` is the maintained implementation used by OpenStack, Anthropic's computer-use demo, and OpenHands, but it declares MPL-2.0, which sits outside the permissive-license allowlist enforced by `scripts/gen-third-party-notices.ts`.

## Decision

Ship `@novnc/novnc` as a bundled runtime dependency of `ui-remote-desktop`, importing the `core/rfb.js` module unmodified. MPL-2.0 is file-scoped weak copyleft: its obligations cover noVNC's own source files, while the larger work formed by the client bundle remains under the project license because no noVNC file is modified. The identity-scoped acceptance in `assertRuntimeLicenses` admits only `@novnc/novnc` at MPL-2.0; other package identities or changed license terms still reject.

Source availability under MPL-2.0 §3.2 is met through `THIRD_PARTY_NOTICES.md`, which directs recipients to the upstream repository `https://github.com/novnc/noVNC` as the corresponding source for the bundled code. The distributed copy is the published npm package; bundler minification does not author new covered files.

## Alternatives considered

**selkies-gstreamer.** Higher framerate, but its default build enables GPL encoders (`PIXELFLUX_ENABLE_GPL=0` is a non-default build option) and it replaces RFB with a custom stream, dropping the cross-platform VNC server compatibility that the provider relies on.

**iframe the stock `vnc.html`.** Avoids bundling but embeds a foreign UI that cannot join the slot, props, and locale discipline of `packages/client/*`, and ships the same MPL-2.0 code anyway.

**IronRDP web component.** Apache/MIT-licensed WASM client, but it is an RDP implementation with no macOS server path; it cannot cover the three-system target set.

**Write a project RFB client.** Removes the third-party terms entirely but re-implements security handshakes, framebuffer encodings, and input message handling that the provider tests already pin to noVNC's behavior.

## Consequences

`THIRD_PARTY_NOTICES.md` records the identity-scoped MPL-2.0 acceptance and the corresponding-source link; the notices spec asserts the committed bytes. Upgrading `@novnc/novnc` keeps the same acceptance, while a license change in the published manifest fails the notices check and requires a new decision. No source copy of noVNC is vendored; recipients exercise their rights against the upstream repository.
