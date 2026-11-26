# Agent Note: Admin SPA cache policy and section control rows

Status: implemented

English | [中文](2026-10-09-admin-shell-cache-and-section-layout.zh.md)

## Problem

Three defects let the admin console render content against or outside section card edges. `serveAdmin` sent no `cache-control`, so heuristic caching could pin `index.html` across a release swap: the old shell then referenced hashed chunks that no longer existed, and the stale or partially loaded bundle drew controls outside their cards. `Section` rendered children bare, so the padded `.sectionBody` band was each page's own obligation — most sections skipped it and free-form content (fields, badges, paragraphs, action rows) hugged the card edges. Separately, two pages placed actions outside the shared row conventions: the Plugins target picker rendered a bare `Button` beside a `Field` with no row container, and the Deployment maintenance form embedded its submit action as a bare `formGrid` cell that floated beside the input instead of aligning with it.

## Decision

`serveAdmin` emits an explicit cache policy on every admin response: `no-store` for the SPA shell and for error responses, and `private, max-age=31536000, immutable` for served files, whose names are content-hashed under `assets/`. `private` keeps the authenticated bundle out of shared caches.

The Admin build precompresses JavaScript and CSS so a cold request can use gzip without running compression in the Gateway. Both representations retain the source MIME type and use `Vary: Accept-Encoding` for cache selection. Negotiation falls back to the original file when a build has no corresponding compressed file.

The initial bundle includes the default Users page. Once a successful user list and deployment context are available and the view has had a paint opportunity, a background task starts the same dynamic Models import used by navigation. The task skips hidden documents, offline browsers, and enabled data saver. Leaving Users cancels queued preparation. Model API requests start when the Models page mounts.

The Models route shares its in-flight import with background preparation. An import rejection clears that shared promise so navigation can request the module again. A rejected navigation still leaves the destination URL active and offers to reload, which obtains a fresh shell after a release replaces its chunks or a browser caches a module failure. Each remaining secondary route imports its own page when matched.

The Models route loads the organization model catalog and its editor. Once the catalog renders a ready snapshot and its model list loads, its first animation frame queues the background import shared by Access & pricing and Personal registrations. Per-user model access populates the override controls and can finish in parallel with that import. Preparation from Users allows two animation frames. Both use a cancellable timer when the browser has no task scheduler. Tab activation starts its data read independently of the shared import. The active tab shows a loading status until the import resolves and then renders its component through ordinary state. This avoids React's 300 ms throttle on commits after a recent Suspense fallback. The import and digest read update only the selection that initiated them. The first governance render receives any settled digest read and the form keeps its state across subsequent renders of that selection. [React retry scheduling](https://github.com/facebook/react/blob/v19.2.0/packages/react-reconciler/src/ReactFiberWorkLoop.js#L1348-L1399)

The catalog editor uses the settings package's [synchronous schema operations](../../../../packages/client/ui-settings/src/client/schema-operations.ts) directly. The settings service delegates to those operations, so both editors apply the same schema and path edits with only the standalone editor's dependencies on the model route.

`Section` owns the padding split: children render inside `.sectionBody` by default, and `flush` marks sections whose content intentionally spans the card edge to edge — tables, filter strips, bulk bars, metric grids, and mobile lists, all of which supply their own padding. Bare banners and paragraphs inside flush sections still receive side margins so a missed strip cannot reach the border. Mixed sections combine `flush` with explicit `.sectionBody` bands around their prose and action rows.

Controls pairing a field with an action sit in dedicated row containers: the Plugins target selector and reload action share `.targetPicker`, a flex row aligned on the bottom edge that wraps on narrow screens, and the Deployment maintenance submit lives in `.formActions` below its field.

## Alternatives considered

**Fingerprint the shell itself.** Rejected: the shell's name is its URL, so `no-store` on `index.html` plus content-hashed assets is the standard split and costs one conditional request per navigation.

**Reuse `.filterPanel` for the plugin picker.** Rejected: that class carries filter-grid spacing tuned for multi-control filter bars; a dedicated two-item row keeps the picker minimal under the same bottom-aligned convention.

**Pad the offenders instead of changing the component.** Rejected: per-page padding is exactly what produced the drift — a default wrapper makes the edge-hugging layout impossible to reintroduce, while `flush` keeps the strip contract explicit at each call site.

## Consequences

A release swap can no longer strand a pinned shell pointing at deleted chunks; every navigation revalidates the shell while hashed assets stay cached. Free-form section content is inset by default, and only `flush` sections can reach the card edge, so edge-to-edge strips stay intentional. Form actions align with their fields on desktop and wrap inside their cards on phones. New sections pairing a field with an action reuse these row containers rather than placing bare controls.

## Verification

`gateway/tests/admin-static.spec.ts` asserts the shell and asset cache policies, gzip negotiation on GET and HEAD, and fallback when a compressed file resolves outside the asset root. `apps/web/tests/admin-layout.e2e.ts` drives the built admin over authenticated HTTP and asserts the reload and maintenance buttons share their field's row on desktop, that free-form fields sit at least `16px` inside their section edges, and that controls stay inside their section cards at `390px` with no page-level horizontal overflow.

The browser suite holds the Users and catalog requests to verify that each background import starts after its source view renders. It holds model access separately to verify that the tab script can arrive before the override data. It verifies script reuse on navigation, the first Models API read, and the reload action after a failed script request. With the shared script held, each tab can complete its data request. The first Access & pricing render after release includes the digest controls.

`gateway/admin-ui/src/components/async-route.spec.tsx` drives the frame callbacks to verify when each preparation is queued and checks disposal of the fallback timer.
