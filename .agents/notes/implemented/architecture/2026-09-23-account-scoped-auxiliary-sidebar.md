# Agent Note: Account-scoped auxiliary sidebar

Status: implemented

English | [中文](2026-09-23-account-scoped-auxiliary-sidebar.zh.md)

## Problem

A single-session docking controller cannot infer which CoHarness Workbench pane initiated an action. Session-only browser storage also shares private tab metadata between accounts using the same origin.

## Decision

Reuse the upstream dockkit and sidebar planners, registry, tab lifetimes, and renderer. Keep the existing Workbench as the only center layout. The frame owns geometry; the sidebar owns tab visibility, splits, and close actions. Tool-detail tabs carry explicit Session and call addresses, and resource navigation validates ownership before changing the layout.

Product persistence requires a verified Gateway account or an explicit independent-Host declaration. Its key includes principal, runtime target, and Session. Unverified identity has no persisted scope and cannot fall back to local access. Identity invalidation clears current tab records and aborts their independent Session references. Reverification restores only matching, validated records. Startup inventory does not enumerate unverified layouts. Resource navigation also requires the current verified key before committing a tab. An unverified interval has no owner for new private layout state, so accepting an open there would let later restoration discard an acknowledged action. The refusal leaves the caller able to present a retry; no deferred action is carried into a later account or verification generation.

Keep the upstream docking and tab-type notes active: they explain reusable ownership and extension rules. This note owns the CoHarness account and multi-pane adaptation, while the [Session reference note](2026-09-23-client-session-references.md) owns generation lifetimes.

Browser reuses upstream iframe navigation, controlled history, unknown-URL reporting, and transient sandbox state. Message links target their explicit Session; modified activation keeps native external navigation. Browser history uses the sidebar's verified ownership key and validates persisted URL policy before restoration. Loopback addresses belong to the visitor's machine, not the execution target.

Markdown file navigation reuses the resource owner and bounded, versioned reader. Line fragments change the text-page offset, not the file identity or authorization. The generic Markdown renderer delegates through the current owner, including links cached during streaming.

Each visible file preview retains only its own last successful content during reload and non-access failures. A failed metadata reload cannot authorize another content read; a successful reload admits a fresh version-guarded read, while a failed successor leaves the old content visibly marked as changed. Native HTTP request failures have a stable transport code and localized explicit-retry feedback, separate from supervised stream reconnection. Identity changes, access denial, request replacement, and tab disposal withdraw the old occurrence rather than carrying content into a new owner.

Tool details read the exact call’s complete turn through the existing Session observation service and assemble it with the registered Conversation definitions. This avoids extending the visible chat window or waking a cold Agent. The Fetch carrier treats the selected turn as indivisible. The sidebar remounts tab bodies on occurrence replacement, including identical tab identifiers restored by different verified accounts; in-flight reads cannot publish into the new occurrence.

## Alternatives considered

**Two right columns.** Keeping the old details column beside the docking sidebar creates competing presentation and resource owners.

**Session-only persistence.** A durable Session identifier is not an authenticated principal or a runtime routing proof.

**Clear content or retry reading after every metadata reload.** A failed stat establishes no fresh read version. Discarding the prior authorized result blanks a usable document, and reading anyway adds a request that cannot fix the failed metadata operation. Retaining one result with a visible failure preserves useful content without reporting freshness or success; authorization loss still withdraws it.

## Consequences

Workspace file navigation uses the same tab owner and existing authorized resource registry. It rejects a changed runtime owner before navigation. Hidden tabs stop content reads while their occurrence retains metadata; closing a tab releases that occurrence. There is no parallel preview-modal selection state.

Unit tests cover resource-owner rejection before commit, account isolation, verification loss, restoration, close failures, and plugin disposal. Product tests cover the assembled Workbench and navigation; sidebar-specific checks exercise collapse, reload, and compact presentation. Additional resource kinds require their own authorized content providers and assembled entry tests; registering a tab type alone does not complete the resource feature.
