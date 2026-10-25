# Agent Note: One authorized plugin management catalog

Status: implemented

English | [中文](2026-10-23-plugin-management-catalog.zh.md)

## Problem

The plugin page needs profile availability, mutation authority, bundles, and live entries before its cards are usable. Asking the full Loader inventory only to learn availability serializes an unrelated large response ahead of the other reads. Starting every read speculatively instead would perform unnecessary work on unmanaged or refused targets. A process-wide profile snapshot would also need independent authority and invalidation rules.

## Decision

The existing `pluginManager` Remote namespace owns one aggregate read. The [package reference](../../../../packages/boot/plugin-manager/README.md#use-this-package) defines its response, authorization, and cancellation. The Web bundle mounts a separate read-only entry so the absence of a profile is observable without weakening the managed service's required `profileContext` dependency. The shared base, headless, and SDK compositions retain their existing providers. This reader allocates no second profile owner and no cross-request cache.

Management projects current Runtime entries through the inventory package's synchronous `readRuntimePluginEntries(ctx)`. The complete `readPluginInventory(ctx)` shares that projection and adds optional preset compositions for diagnostic consumers. A management read never waits for preset discovery, parsing, or disabled-expression evaluation that its response cannot expose. Metadata, effective enablement, live phases, and Loader order have one projection; preset health and composition remain owned by the roster.

Authorization remains owned by [the deployment policy](2026-09-22-gateway-profile-management-authority.md) and the existing transport assertions. The reader checks authority before starting the original reads and before publishing them; bundling values into one response does not make them an atomic profile revision. Existing methods remain usable by tools and other consumers.

The Gateway runtime's signed-purpose HTTP allowlist names `pluginManager/catalog` explicitly. Registering a Remote method does not admit its transport route. Administrator assertions remain restricted to the declared POST paths and retain the profile's authority check.

A catalog request owns one operation until its started reads settle. Cancellation and disposal reject late publication and drain those reads before the owner releases its effect. The current individual readers do not accept cancellation, so the aggregate makes no claim that an aborted request stops synchronous file work. Browser controllers cancel their owned catalog lifetime, retain existing refresh coalescing, and reject responses after disposal; an Admin target replacement owns a new controller and transport generation.

The Admin live controller passes each accepted catalog to the same target's composition matrix. The matrix registers its post-write catalog refresh with that controller; registration cleanup removes only its own callback. Durable startup state remains an independent read. The controller reports settled writes explicitly, so startup refresh does not depend on rendering an intermediate busy state and initial idle does not start a second read. Composition reads and write settlements check their captured target lifetime before publishing or requesting another refresh. A per-owner read sequence also prevents a slow initial state read from replacing a newer post-write result; acknowledged saves retire older reads without starting another request. No settled catalog survives target replacement, and configuration keeps its independent settings read.

## Alternatives considered

**Run four browser requests concurrently.** Availability is learned only by reading the full Loader inventory, and the other three calls would start even when management is absent or reading is refused. A single owner can apply the existing checks before the profile work begins.

**Add profile fields to the global Host description.** Every connection handshake would pay for a feature-specific catalog, and the central transport would acquire profile-management responsibilities. The current Remote service owns these reads.

**Cache a joined catalog between requests.** Profile edits, Loader replacement, and authorization revocation have distinct lifetimes. A cache adds invalidation work and risks stale authority without removing the initial request dependency.

**Read complete preset compositions for Runtime entries.** Management consumes only the runtime entries from that larger result. Inspecting inactive presets adds unrelated file work and expression evaluation, and a failed preset read can reject otherwise available Runtime entries. Diagnostic consumers retain the complete reader.

**Keep separate live lists for the Admin matrix.** They repeat the catalog's authenticated plugin and bundle reads within the same mounted target. Publishing the controller's accepted values preserves one freshness owner; the durable startup-state request remains separate because the catalog does not contain it.

**Mount the reader in the shared base.** Current catalog consumers select Web runtimes. A Web-owned row supports unmanaged Web compositions while preserving headless and SDK startup scope.

**Fallback to older endpoints on missing catalog.** Silent version fallback restores the serial dependency and conceals an incomplete custom Web composition. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/plugin-management-catalog/guide.md) owns the explicit migration.

## Verification

A controlled completion barrier through the production page controller admits exactly one catalog request while pending and no inventory, bundle, entry, or access request. This assertion rejects the serial reference implementation. Request counts establish a dependency removal, not first paint or a guaranteed latency gain.

The assembled [inventory-demand scenario](../../../../apps/web/tests/plugin-inventory-demand.e2e.ts) observes a private file append from an inactive preset's real Loader expression. Opening management evaluates it zero times; opening the complete Settings inventory evaluates it and displays the preset's plugin row. The original implementation evaluates it once during management and fails this assertion. A manager regression also keeps Runtime listing available when preset composition reads reject. These work-count checks do not attribute a public network delay to preset inspection.

The plain-Node [built Remote test](../../../../packages/api/remotes/tests/built-lib.e2e.ts) resolves the published entry through the Web bundle's real Loader and exercises generated Client codecs over authenticated HTTP for unmanaged, read-only, refused, and authorized managed catalogs. Provider tests require zero profile reads before admission, final permission rechecks, sibling drain on failure, and joined disposal. Controller and Admin transport tests retain refresh and mutation behavior, reject malformed wire values, cancel the selected target, and ignore a replaced generation's late result.

The assembled [Admin workflow](../../../../apps/web/tests/plugin-administration.e2e.ts) crosses the built CLI's signed `plugin-admin` route before installing a local bundle and enabling it through the actual page. The [runtime admission tests](../../../../packages/context/gateway-runtime/tests/gateway-admission.host.spec.ts) reject unsigned catalog requests; the purpose-method matrix rejects GET and upgrade requests for the same endpoint.

The real Admin page component regression holds its first catalog pending and requires one startup-state read, one catalog request, and zero legacy plugin/bundle list calls. The `180b8a7c261` reference issues two startup reads and four legacy list calls. Follow-up cases retain settings reads, matrix writes, focus retry, StrictMode cleanup/setup, authorization invalidation, target replacement, and late catalog/write fencing. These are request-count and lifecycle checks; the sanitized public capture's request durations do not measure candidate end-to-end improvement.

## Consequences

The page's first load and refresh use one response instead of a serial inventory dependency followed by three reads. Profile data stays live and permission-checked without another persistent projection. Custom raw Web compositions must mount the explicit catalog entry, and Host, Client, and Admin generated artifacts must agree on the endpoint. Actual network latency and time to visible cards remain assembled-browser measurements.
