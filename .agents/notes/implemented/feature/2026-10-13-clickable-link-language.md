# Agent Note: Unify clickable-link language and ship the gallery e2e

Status: implemented

English | [中文](2026-10-13-clickable-link-language.zh.md)

## Problem

The local tree carried the `LinkIcon` primitive and the `--dsw-alias-link` token but never consumed them: markdown anchors, file mentions, `WebBlock` source/fetch links, produced-file chips, and `WorkflowRunPanel` member labels each kept their own color, weight, and underline treatment, and no `LinkIcon` led any link. Porting upstream's clickable-links-gallery e2e also exposed a real product bug: the Settings link-opening row never rendered, because `ui-conversation` probed `ctx.reflect.get('sidebarRightTabs')` once at apply time while client entries are created concurrently — the registry lands after the probe on every boot. Upstream sources: `8ffdee4fe5d` (link language + gallery) and `3eab1714bcd` (link-opening preference), both in alpha.2.

## Decision

All five link surfaces now share one language: `--dsw-alias-link` color, `font-weight: 500`, no underline at rest, and a dotted underline offset 3px on hover/focus. `LinkIcon` leads each markdown anchor (`MarkdownAnchor`/`renderSafeLink` accept a `glyph` flag so image-only anchors stay glyph-free), each text-node file mention, each `MarkdownFileLink`, every `WebBlock` `SafeLink`, and each produced-file chip; `classifyLinkPath` picks the category glyph per surface. The inline-code chip token moves to `neutral-50`/`neutral-800` and gains the 0.5px border, so URL-promoted inline code reads as a link inside a distinct chip.

Produced-file chips drop the grey pill and the 96px cap: they render at natural width inside the flex row and shrink with ellipsis only on overflow; the container-query bands keep the 96px budget when counting how many chips fit. `show-in-folder` becomes the same link form with a folder glyph. `WorkflowRunPanel` member labels take the shared link treatment. Tool-row dotted file links and the generic grey affordances stay as they were — upstream excludes them from the new language on purpose.

The Settings row registers inside `ctx.inject(['sidebarRightTabs'], scope => ...)`: the contribution appears the moment ui-sidebar-right provides the registry and disappears when it leaves, which is immune to concurrent entry creation. The registry type stays a local structural interface because ui-sidebar-right's project reference points back at ui-conversation — a typed Context merge would close the reference cycle.

`apps/web/tests/clickable-links-gallery.e2e.ts` ports the upstream gallery: one seeded keyless turn exercises plain/reference/mailto/inline-code anchors, inert `javascript:`/ftp/command-code contrasts, a remote image, unique-basename versus ambiguous/unwritten file mentions, tool-row file links (including the failed-write and unclassified-tool exclusions), the collapsed `web_fetch` URL link, safe HTTP(S) source links, generic-row expansion, the sidebar-versus-new-tab settings roundtrip through the real settings provider including a reload and session reselection, computed-style assertions (link color, weight, rest/hover decoration, leading glyph), and a stable ARIA golden. The `nativeOpen` overlay pins the show-in-folder branch identically on CI and desktop hosts.

## Alternatives considered

**Ordering `ui-sidebar-right` before `ui-conversation` in the web patch.** Rejected: `client/modules` creates entries concurrently, so list order does not serialize apply and the race would remain; upstream's `ctx.inject` gate is the mechanism that actually waits for the service.

**Waiting for the registry inside `getSnapshot`.** Rejected: a snapshot can re-read lazily, but nothing notifies subscribers when the registry arrives — the row would still render absent on first paint. The inject gate re-registers the contribution itself.

## Consequences

Every clickable artifact in the transcript reads as one language, and the gallery e2e pins it end to end. Assemblies without `ui-sidebar-right` show no link-opening row instead of a dead preference. Upstream's later `LinkIcon` evolution — `siteGlyph` favicon variants and `LinkIconMedium` from `7520fe94e14` — is not ported; the local primitive remains the `8ffdee4fe5d` baseline, recorded as an adjacent gap in the audit.

## Verification

`link-icon`/`markdown-dom-parity`/`markdown-file-links`/`web-block`/`produced-files` specs pass (1130 tests across `ui-primitives`, `ui-deliverables`, `ui-workflow-run`), with regenerated markdown-dom fixtures covering the image-only-anchor case added to the corpus. `chat-apply.client.spec.tsx` provides the registry in its bench and adds a lifecycle case: no row without the registry, row appears when a plugin provides it, row disappears on dispose. The gallery e2e passes in replay mode against the committed golden with zero page errors and zero console warnings.

## Related

- `../architecture/2026-09-20-upstream-alpha2-client-lane-audit.md` — the campaign audit this batch feeds.
- `../bug-fix/2026-10-15-web-fetch-summary-url-link.md` — the collapsed-row URL anchor this gallery exercises.
