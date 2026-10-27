# Agent Note: Preserve initial Workspace selection through bootstrap Runtime identity

Status: implemented

English | [中文](2026-10-24-bootstrap-runtime-initial-selection.zh.md)

## Problem

A project page can receive complete Workspace and Session lists yet remain on the unselected Hero. The initial-selection intent starts before the connection handshake. Resolving the pool's provisional personal target to the authenticated project target cancels that intent, so the one-shot subscriber never applies the existing history-first policy.

Account context verified before the first Host handshake can also lose its proof through the generic connection reset. That unnecessary withdrawal cancels initial navigation through the conversation viewport, making startup depend on response ordering.

## Decision

The Session pool distinguishes its first established bootstrap identity from a later target change. The first declaration preserves the existing navigation signal; it never creates a replacement for an intent a user has already cancelled. A connected independent Host also establishes its identity, so a subsequent target change retains normal cancellation semantics.

Runtime marks only its first connection reset as initial. Collaboration preserves context already verified in this document or joins its pending initial read. Every later readiness handshake synchronously withdraws old verification through `connection/will-reset`, before connected state and the Host description are published. The subsequent `connection/reset` forces a new context read; an unspecified reset also revalidates. This first-handshake fact belongs to the producer, so a listener installed after startup cannot mistake a reconnect for initialization. The [principal-owned layout decision](../architecture/2026-09-23-principal-owned-workbench-layouts.md) continues to govern actual identity loss and account changes.

History remains behind authenticated Runtime identity, both authoritative list baselines, archive checks and ordinary Session opening. Identity projection still cancels an unclaimed restored-history read and refuses to relabel retained Session generations. Later target changes, explicit user navigation, account withdrawal and disposal retain their existing cancellation ownership.

Initial selection publishes pending feedback from the first baseline wait through prepared-history commit. An absent current Session alone cannot distinguish that interval from a settled empty Workspace. The resident composer remains mounted while this interval hides its choice prompt; an already current blank retains its Hero. Workbench navigation remains reachable in the header during initial selection. The selection owns a cancellation signal combined with the navigation intent, so disposal releases this preparation without cancelling another history owner. A failed Workspace baseline or Session preparation removes pending feedback and retains the authoritative Workspace/Session input references as its retry checkpoint: feedback publication cannot itself start another attempt.

The [history-first Workspace decision](2026-08-26-workspace-history-first-entry.md) continues to own candidate selection. The [archived-selection decision](2026-10-04-archived-selection-races.md) continues to own archive masking and commit-time refusal; neither decision is superseded.

## Alternatives considered

**Remove target-change cancellation.** Rejected because a confirmed target change must cancel the old navigation and unclaimed history window, preventing late data from becoming the new selection.

**Create a fresh startup intent after identity or baseline arrival.** Rejected because that intent could overwrite an explicit user clear or Session navigation made while initialization was pending.

**Read or select before identity confirmation.** Rejected because a changed account or scope must not reuse another Runtime's requests, retained generations or private data.

**Preserve account verification on every connection reset.** Rejected because reconnects must revalidate permissions and release private layout ownership. Only the first handshake can share that document’s initial verification, whether pending or complete.

**Withdraw verification only in the post-description reset.** Description subscribers synchronously restore principal-owned layouts. Withdrawing afterward transiently restores stale panes and resource holds, then discards them before a second restoration. The pre-publication notification prevents that duplicate work while the ordinary reset retains fresh verification and baseline ordering.

## Consequences

A project bootstrap can apply the same default selection as a personal bootstrap without additional Workspace or Session clicks. Baseline reads remain independent, and the change adds no request, model call, cache or timer. Workspace-row expansion and explicit New Session behavior remain separate product actions. No millisecond improvement is inferred from manually sampled browser states.

## Verification

The real Connection controller, Session pool and Workspace runtime regression holds identity and list responses independently. The assertion fails on the original implementation with no current Session and passes after the fix. The owning unit file also verifies a clear before identity, clear or manual selection during history opening, account withdrawal, personal identity confirmation and cancellation on a later target change. Producer and collaboration tests distinguish the initial handshake, late listeners, verified context, failed revalidation and reconnects. A keyless assembled browser case holds the real Host description and Workspace response independently, confirms account context before releasing the final list baseline, and admits only one history request while its first response is held. Releasing that response selects the existing project conversation against its golden; later live-event convergence may read the tail again.

Controlled baseline and history responses verify one initial loading status with no premature Workspace choice, followed by the existing conversation without creating a Session. A failed Workspace baseline restores the existing list error and Retry control; Retry exposes loading until a successful baseline. Component checks preserve the composer nodes and the known-current blank Hero. Independent history retention completes after initial-selection disposal.

A keyless assembled browser regression holds the initial account response through the real handshake and checks one context request without cancellation. A second case reconnects the real Host stream, holds revalidation, and counts private-layout storage reads: none before verification, then one for the matching account. Both cases compare the authorized Markdown preview through the real file reader. Controlled connection tests also cover callback failure isolation and stopping the generation before publication.
