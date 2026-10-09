# Agent Note: Admin SPA cache policy and section control rows

Status: implemented

English | [中文](2026-10-09-admin-shell-cache-and-section-layout.zh.md)

## Problem

Three defects let the admin console render content against or outside section card edges. `serveAdmin` sent no `cache-control`, so heuristic caching could pin `index.html` across a release swap: the old shell then referenced hashed chunks that no longer existed, and the stale or partially loaded bundle drew controls outside their cards. `Section` rendered children bare, so the padded `.sectionBody` band was each page's own obligation — most sections skipped it and free-form content (fields, badges, paragraphs, action rows) hugged the card edges. Separately, two pages placed actions outside the shared row conventions: the Plugins target picker rendered a bare `Button` beside a `Field` with no row container, and the Deployment maintenance form embedded its submit action as a bare `formGrid` cell that floated beside the input instead of aligning with it.

## Decision

`serveAdmin` emits an explicit cache policy on every admin response: `no-store` for the SPA shell and for error responses, and `private, max-age=31536000, immutable` for served files, whose names are content-hashed under `assets/`. `private` keeps the authenticated bundle out of shared caches.

`Section` owns the padding split: children render inside `.sectionBody` by default, and `flush` marks sections whose content intentionally spans the card edge to edge — tables, filter strips, bulk bars, metric grids, and mobile lists, all of which supply their own padding. Bare banners and paragraphs inside flush sections still receive side margins so a missed strip cannot reach the border. Mixed sections combine `flush` with explicit `.sectionBody` bands around their prose and action rows.

Controls pairing a field with an action sit in dedicated row containers: the Plugins target selector and reload action share `.targetPicker`, a flex row aligned on the bottom edge that wraps on narrow screens, and the Deployment maintenance submit lives in `.formActions` below its field.

## Alternatives considered

**Fingerprint the shell itself.** Rejected: the shell's name is its URL, so `no-store` on `index.html` plus content-hashed assets is the standard split and costs one conditional request per navigation.

**Reuse `.filterPanel` for the plugin picker.** Rejected: that class carries filter-grid spacing tuned for multi-control filter bars; a dedicated two-item row keeps the picker minimal under the same bottom-aligned convention.

**Pad the offenders instead of changing the component.** Rejected: per-page padding is exactly what produced the drift — a default wrapper makes the edge-hugging layout impossible to reintroduce, while `flush` keeps the strip contract explicit at each call site.

## Consequences

A release swap can no longer strand a pinned shell pointing at deleted chunks; every navigation revalidates the shell while hashed assets stay cached. Free-form section content is inset by default, and only `flush` sections can reach the card edge, so edge-to-edge strips stay intentional. Form actions align with their fields on desktop and wrap inside their cards on phones. New sections pairing a field with an action reuse these row containers rather than placing bare controls.

## Verification

`gateway/tests/admin-static.spec.ts` asserts `no-store` on the shell, nested SPA routes, and missing or escaped paths, and `private, max-age=31536000, immutable` on hashed assets. `apps/web/tests/admin-layout.e2e.ts` drives the built admin over authenticated HTTP and asserts the reload and maintenance buttons share their field's row on desktop, that free-form fields sit at least `16px` inside their section edges, and that controls stay inside their section cards at `390px` with no page-level horizontal overflow.
