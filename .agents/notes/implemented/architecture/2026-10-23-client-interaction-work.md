# Agent Note: Keep client update work proportional to the visible change

Status: implemented

English | [中文](2026-10-23-client-interaction-work.zh.md)

## Problem

A token, completed model attempt, directory refresh, or Session metadata change can invalidate presentation work for an entire loaded history or catalog. Stable row projections alone do not remove repeated navigation scans, view reconstruction, synchronous preference writes, or work in CSS-hidden views. A collapsed result also incurs unnecessary work when its preview visits values that the user has not expanded.

## Decision

Conversation settlement removes transient rows from their owning Contexts and replays affected Contexts and predecessor dependents. It retains unaffected historical nodes. Location reconstruction and view replacement remain available where a removed Context or incomplete boundary requires them. The [conversation assembly decision](2026-08-09-client-conversation-node-assembly.md) retains authority over event order, reader dependencies, and Location membership.

Chat navigation updates the turns touched by changed nodes or changed timeline boundaries. Turn-order changes rebuild the navigation index. Process grouping computes the loaded window's last-turn indexes only when an actual regroup needs them. Full replacement, history prepend, hidden-node transitions, and moved locations retain their existing semantics.

Catalog reconciliation indexes incoming identities and insertion anchors instead of repeatedly scanning the current array. It preserves established row order, latest baseline values, and placement of new identities. Refreshes without new identities return retained rows before constructing insertion structures. Initial list hydration remains a separate path. The [list projection decision](2026-10-23-client-list-projection-reuse.md) continues to own source-identity reuse and runtime-descriptor invalidation.

Each base-connection generation reads its Workspace baseline once through the Workspace manager. The Workspace and Session archive projections share the successfully installed, revision-aware archive result. A disconnect or disposal cancels the pending read and invalidates late delivery; the next generation requests a fresh baseline. Workspace frames still replay over the response, and archive revisions prevent stale results from replacing newer state.

Workspace navigation shares one merged summary lookup per source snapshot and commits reconciled order accounts in one store action. The resulting persisted preference snapshot is complete; no consumer relies on the intermediate per-account writes. React Activity suspends the hidden ordinary directory's effects while preserving its local viewing state in workbench mode. Hidden content search aborts its request and reads the current query again on return. The [workbench decision](2026-09-08-cordis-multi-session-workbench.md) retains authority over layout and Session ownership.

JSON previews read only the values within their existing item and depth limits. Explicit expansion and copy still access the complete value. Read cards construct rows for the visible slice and defer full plain-text concatenation until copy. File-tree stores retain an unchanged listing by comparing all declared navigation and freshness fields; changed metadata and recovered errors still publish. Display sorting follows each directory's entry identity.

## Alternatives considered

**Replace all history after every settled attempt.** This rematches and rebuilds unrelated completed turns. Selective replay retains the same reconstructed content and preserves unaffected node identities. Cases requiring removal or a complete reset keep their explicit reconstruction paths.

**Unmount hidden navigation or truncate large results.** Unmounting loses local viewing state. Truncation changes what expansion and copy can retrieve. Suspending hidden effects and limiting preview work preserve those user operations.

**Cache by identifier alone.** Identifiers do not encode changed metadata, source versions, timeline boundaries, or owning runtime descriptors. Reuse follows immutable source identities or compares the complete declared listing fields.

**Rewrite the startup dependency loader.** The shipped page already preloads the relevant application bundles. A synthetic transport waterfall does not establish a cold-start improvement through that production entry path.

## Consequences

These changes reduce browser work while preserving model requests, durable Session records, pagination, visible ordering, and result completeness. Full history inspection and explicit expansion still cost work proportional to the requested content. Settlement still reconstructs timeline indexes; it does not make every operation constant-time.

Owning regressions compare incremental output with replacement, preserve unrelated references, exercise moved and hidden nodes, verify refresh freshness and error recovery, and prove hidden-view cleanup and reactivation. Work-count negative controls reproduce the original repeated work. Browser replay exercises the shipped composition with synthetic long history, real input during output, navigation, JSON expansion, and file refresh. Component work counts and local loopback timings are distinct evidence; neither establishes public-tunnel latency or model-provider response time.
