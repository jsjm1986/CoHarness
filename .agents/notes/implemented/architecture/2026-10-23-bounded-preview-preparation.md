# Agent Note: Bounded workspace preview preparation

Status: implemented

English | [中文](2026-10-23-bounded-preview-preparation.zh.md)

## Problem

File reads, Office conversion, and viewer-code downloads have independent prerequisites. Serializing them adds another network wait before first content. An HTML preview can contain many independent local assets; reading each one after its predecessor makes public-network latency accumulate even when files are small. Increasing parallelism without byte reservations would exchange this delay for unpredictable memory retention.

## Decision

The preview overlaps only preparations that require no document content. Authorized metadata starts the selected PDF or spreadsheet code import alongside its existing content reader. A component-owned import promise observes early rejection and preserves it for React's render error handling; completion cannot mount a body or start a Worker without successfully authorized bytes. The [authorized Office preview](2026-09-23-authorized-office-preview.md) retains all content checks and worker ownership, and the [package README](../../../../packages/client/ui-workbench/README.md#composition) owns the loading and cancellation behavior.

PDF documents need different subsets of CMaps, standard fonts, and image decoders. Loading these complete resources by kind avoids transferring every binary before the viewer can start without narrowing supported documents. Their three chunks export only data: sharing renderer or lifecycle code with them could introduce a synchronous chunk dependency that the loader cannot materialize. The existing module loader retains code identity and transfer ownership; a document's cancelled resource reads reject independently of an unfinished code import so PDF teardown need not wait for that transfer.

HTML asset batches derive their width from the existing per-asset and total-byte limits. Reserving the maximum possible bytes for each pending read bounds retained asset bytes without another deployment tuning value. A remaining budget smaller than the per-asset maximum permits one read at a time because the actual asset may fit. Results retain authored order; failure aborts sibling reads and waits for their settlement before the package operation rejects. The [HTML preview decision](../feature/2026-09-25-workbench-html-markdown-previews.md) retains resource addressing, authorization, static dependency admission, and iframe isolation.

The spreadsheet import points directly to the licensed renderer/parser chunk. Its small loading surface belongs to the main bundle; a separate forwarding chunk performs no independent work and adds a request dependency. The [spreadsheet preview decision](../feature/2026-10-01-workbench-spreadsheet-preview.md) continues to own parser fidelity, limits, and read-only presentation.

Embedded PDF and spreadsheet notices use preservation-marked line comments. Ordinary comments can be discarded during code compaction; marking only a heading leaves the notice body unprotected. The published lazy chunks retain complete notice text.

## Alternatives considered

**Import only after content completes.** This avoids downloading viewer code for a failed read, but serializes independent work on every cold document open. Starting a Worker or executing document bytes early remains excluded: code preparation does not authorize content.

**Preload every viewer when the application boots.** Every visitor would transfer and initialize PDF and spreadsheet dependencies, including users who open neither format. The selected preview supplies the narrowest useful preparation intent.

**Remove rarely used PDF fonts or decoders.** Common documents do not exercise every CMap, standard font, JPEG2000, or JBIG2 path. Keeping all same-version resources behind requested groups preserves those paths without imposing their bytes on every first preview.

**Read all HTML assets with one unbounded `Promise.all`.** The asset-count limit alone permits many maximum-sized files in flight before the package-size check rejects. Reserving against the existing byte limits constrains that allocation and keeps the single-file tail readable.

**Add a shared content or import cache.** Content remains subject to each preview's authorization and revocation lifetime. The client module loader already owns code transport singleflight and module identity; another module-level cache adds invalidation and disposal duties without removing a request dependency.

**Keep the spreadsheet forwarding chunk.** Its small transfer does not defer any work beyond the heavy chunk's existing dynamic import. The extra dependency increases cold-open latency without keeping more parser or renderer code out of the main bundle.

## Verification

The [synthetic packer diagnostic](../../../../packages/client/ui-workbench/tests/html-pack-perf.client.ts) releases all currently pending reads at a controlled completion barrier. For 24 direct script assets, the serial reference requires 24 completion waves and this preparation policy requires 4, with the same 24 reads, asset order, and package digest. A wave measures a read dependency, not milliseconds, HTTP request count, CPU cost, or first paint; each asset reader can itself issue several authorized RPCs. Browser latency requires separate evidence from the assembled application.

Production-component regressions hold content reads and imports independently to prove selected-only preload and no late mount. Packer regressions cover byte reservations, limits, ordering, rejection, sibling cancellation, and draining. Published-package tests keep heavy dependencies behind direct lazy imports and preserve their licenses; reintroducing the forwarding chunk violates the package's closed file list.

The [resource Worker smoke](../../../../packages/client/ui-workbench/tests/pdf-resource-smoke.client.spec.ts) renders self-authored vector, standard-font, Japanese CMap, JPEG2000, and JBIG2 PDFs through the installed parser and real resources. The [assembled preview](../../../../apps/web/tests/workspace-office.e2e.ts) observes actual lazy-chunk requests: a vector PDF requests no resource groups, and subsequent documents reuse their required groups. The packed-artifact guard executes each data-only factory without dependencies, compares every decoded resource with its version-matched vendor file, and rejects synchronous sibling imports.

## Consequences

Cold previews can overlap code transfer with authorized reads or conversion. Failed reads can waste the selected viewer download; the JavaScript import API cannot cancel its underlying transfer, so cancellation prevents publication and Worker creation rather than claiming to stop that network request. HTML packing retains at most a byte-budgeted batch alongside completed assets, and rejects only after its owned reads settle. These bounds describe package bytes rather than the browser's total heap, which also contains decoding and viewer state.
