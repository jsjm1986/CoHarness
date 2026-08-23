# Agent Note: CoHarness browser branding

Status: implemented

English | [中文](2026-08-23-coharness-browser-branding.zh.md)

## Problem

The local Web build exposed the upstream fish mark, `DSH Local Build` label, and DeepSeek Harness install metadata even though CoHarness is an independently maintained product. The same fallback mark appeared in the blank-session Hero, so replacing only the sidebar left the first-run surface with mixed branding.

## Decision

Local browser surfaces use the independent CoHarness mark and name: the sidebar and blank-session Hero fallbacks, the document title, the PWA manifest, and the emitted favicon. The existing `sidebar.brand.*` and `conversation.hero.brand.mark` slots remain unchanged so deployment packages can still provide their own occupants. The official build profile keeps its DeepSeek Harness title, wordmark occupants, and favicon by selecting the preserved official source during the Web build.

The mark is a small open arc with a connected node, rendered by the Cordis-free `CoHarnessMark` primitive with `currentColor` so it follows each host surface's theme. No model-visible input, session event, transport field, or internal package naming changes.

## Verification

Focused primitive, sidebar, renderer-title, and Web artifact tests cover the new mark, fallback label, title projection, profile-aware manifest, and profile-aware favicon. The built Web artifact test accepts either the local or official profile and checks the corresponding install metadata. The browser hover regression continues to exercise the mark animation through its stable host box.

## Alternatives considered

**Rename the internal DSH package and asset vocabulary** — rejected because compatibility work still relies on the existing package names, slot names, and official profile selectors. The change is limited to browser-visible fallback presentation and build output; internal runtime terminology remains stable.

**Replace the slot system with a dedicated CoHarness branding plugin** — rejected because the existing slots already provide the required extension point and the local fallback must work when no optional branding package is mounted.

**Use the upstream fish asset with a new label** — rejected because the mark itself is part of the user-facing brand and retaining it would continue to imply the upstream product.

## Consequences

Production builds without an explicit official profile identify themselves as CoHarness while retaining the existing `DSH_CLIENT_COMMIT_HASH` diagnostic badge. Official release artifacts remain compatible with the upstream brand package and metadata expectations. The two favicon source assets are an implementation detail of the Web build; the public URL remains `/favicon.svg`.
