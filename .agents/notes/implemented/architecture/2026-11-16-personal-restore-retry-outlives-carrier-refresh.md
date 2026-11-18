# Agent Note: A saved-selection restore retry outlives the refresh that carries it

Status: implemented

English | [中文](2026-11-16-personal-restore-retry-outlives-carrier-refresh.zh.md)

## Problem

[personal-directory.ts](../../../../packages/client/runtime/src/client/personal-directory.ts) restores the persisted personal-computer selection after the directory lands. Attention events (`online`/`focus`) ask `refresh(retrySelection = true)` to retry the pending restore when fresh metadata arrives — the recovery path the `personal-navigation-resume` scenario exercises.

`refresh(retrySelection)` was a per-call parameter applied only by the flight that call started, so the same event-loss family the [revisit-coalescing note](../bug-fix/2026-11-09-personal-directory-revisit-coalescing.md) fixed at `focus` and `restoreSelection` survived inside `refresh` itself:

- An in-flight `work` made `refresh(true)` return the existing promise; that flight applied `retrySelection = false`.
- `deploymentContext.subscribe` aborts the in-flight request on every publish and restarts a *plain* `refresh()` — the aborted flight throws at `throwIfAborted`, the catch swallows it, and the replacement flight applied `retrySelection = false`.

Either way `restoreSelection(true)` never ran: the pending conversation intent stayed `unavailable` forever with no further automatic trigger — the CI failure mode where the intent editor waited out its full hide timeout.

## Decision

A retry request is a pending intent, not a call argument. `refresh(true)` records `selectionRetry = true` before any early return; whichever refresh next settles the directory — publishing metadata or failing — applies it via `restoreSelection(selectionRetry)` and consumes it. Aborted, superseded, dropped, and policy-skipped refreshes therefore cannot lose the retry — the same coalescing idiom as `retryQueued` (in-flight restore) and `revisitQueued` (in-flight revisit).

The flag resets with the account scope (`identity()`), because a queued retry belongs to the account whose selection it restores.

## Alternatives considered

**Retry only inside `focus`'s flight.** Rejected: the drop happens inside `refresh`, below `focus`; any other `refresh(true)` caller (hostDescription, account verification) carries the same intent.

**Clear on the first landing attempt regardless of outcome.** Rejected: an aborted carrier never reaches `restoreSelection`; consuming the flag there would reintroduce the loss.

## Consequences

An `online`/`focus` retry now lands on the next refresh that publishes directory metadata, however many superseded flights preceded it. A consumed retry that still fails leaves the intent `unavailable` for an explicit user retry — no retry loop was added and `restoreSelection`'s guards (recovery, aborted signal, in-flight `restoreWork`, intent `active` match) stay the sole adjudicator.

## Verification

`personal-directory.client.spec.ts` gains a case that parks the retried refresh on a held catalog response, republishes `deploymentContext` mid-flight (abort + plain restart), and observes the second `ensureSession` call committing the saved session. Red/green verified: the spec fails without the flag. `personal-navigation-resume.e2e.ts` covers the browser path.
