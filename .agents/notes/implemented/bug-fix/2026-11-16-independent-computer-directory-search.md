# Agent Note: Keep account discovery and search results independent of slow computers

Status: implemented

English | [中文](2026-11-16-independent-computer-directory-search.zh.md)

## Problem

A tab’s initial Runtime is an execution target, not the owner of its organization directory. Requiring that computer’s account context before presenting other authorized computers makes one unavailable node block navigation. Combining all connected Runtime searches into one final publication creates the same dependency for content results; successful results also need to distinguish an unavailable peer from an empty result.

## Decision

[EntryDirectory](../../../../packages/client/runtime/src/client/entry-directory.ts) obtains current account, project membership and exact bootstrap identity from the center-owned `/account/api/workbench/context`. The [Gateway](../../../../gateway/src/server.ts) resolves that identity using governance data and checks the entry’s permitted node scope without preparing or forwarding to the target Runtime. Existing paged Runtime grants and node-local metadata reads retain their authority. Project names and paths whose content is node-owned remain placeholders in the center directory.

[SessionRuntimePool](../../../../packages/client/runtime/src/client/sessions/pool.ts) reports progress for each already connected Runtime. Request-local snapshots contain qualified result identities and pending, ready or failed states; cancellation or disposal prevents later publication. The final promise retains its combined-result semantics for consumers that do not render progress. [WorkspaceBrowser](../../../../packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx) retains successful results while other computers are pending or unavailable, and displays matching computer headings alongside conversation and Workspace matches.

## Alternatives considered

Using the last successful bootstrap context would keep navigation responsive but could retain withdrawn grants. Reading current central governance preserves permission checks without making a different computer’s availability a prerequisite. Searching every registered computer would expand the user’s requested scope and establish unnecessary Runtime connections; search remains limited to the pool’s existing connections.

## Consequences

An offline execution node cannot prevent the center from listing other authorized targets. Its own content still requires its node’s current permission checks and availability; no operation silently changes to another computer. Workbench All spaces searches only authorized conversations already loaded in the same tab, with explicit per-space pagination for more content. Discovery and search do not change drafts, tab selection, active tasks or scheduled work.

## Verification

The Gateway route tests verify offline bootstrap discovery, exact target and principal refusals, and zero forwarding or Runtime startup. Client tests hold one search pending, verify another publishes first, exercise cancellation and peer failure, and retain conversation matches when a computer name also matches. The [personal-computers browser scenario](../../../../apps/web/tests/personal-computers.e2e.ts) uses two independent Web Hosts and records the visible fast result before releasing the other computer’s response.
