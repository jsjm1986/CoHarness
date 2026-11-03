# Agent Note: Memory consolidation coalesces shared scopes

Status: implemented

English | [中文](2026-10-31-memory-consolidation-coalescing.zh.md)

## Problem

Consolidation eligibility belongs to a memory scope, while completed-turn lanes belong to Sessions. Two Sessions can read the same eligible cursor before either model request finishes. Conditional cursor publication protects newer data but cannot prevent both reviews from spending model resources on the same catalog.

## Decision

The curation plugin owns a set of active scope identities. It acquires a scope before reading eligibility and retains it through model iterator cleanup and conditional cursor publication. Another Session's concurrent trigger for that scope coalesces into the active review. Full scope identities distinguish directories and SSH targets; unrelated workspaces remain concurrent. Every exit releases the scope, including denial, model failure, cancellation and an ineligible cursor.

Each scope decision reads current feature switches and verifies the execution provider captured by the triggering turn. An active review can finish its admitted work, while later scopes refuse disabled features or replaced authority. A failed or cancelled review keeps its existing progress eligible for a later completed turn.

The [conditional cursor decision](2026-10-23-consolidation-cursor-concurrency.md) remains necessary for member edits during a review. The [scope enforcement decision](2026-10-28-memory-curation-scope.md) owns tool access. The [execution identity](2026-10-23-curation-execution-identity.md), [request ownership](2026-10-24-memory-auxiliary-ownership.md) and [cancellation](2026-10-23-curation-cancellation.md) decisions retain their independent responsibilities.

## Alternatives considered

**Rely only on the final cursor comparison.** It rejects stale completion metadata after duplicate model work has already run.

**Queue every Session behind the active review.** A second feature queue retains captured Session state before model resource admission. Coalescing duplicates avoids that queue; durable change markers retain work for later turns.

**Serialize all consolidation.** Different workspace and SSH scopes have independent catalogs and cursors. One global exclusion would delay unrelated work.

## Consequences

One curation plugin performs at most one active review of a scope. Member writes remain concurrent, and their cursor changes can require another review. Coalesced triggers are not individually retried; consolidation still runs on completed turns. The exclusion belongs to the plugin and supplies no cross-process lock.

## Verification

Controlled overlapping Session decisions reproduce two model calls for one project scope. The real Loader, two Agents, JSON storage and model admission provider reproduce two concurrent auxiliary requests when scope exclusion is removed. The maintained transcript requires one auxiliary request, three total model admissions and confirmed release of every admission. Source cases also cover independent directory and SSH identities, failure and cancellation recovery, feature withdrawal, and execution-provider replacement between scopes.
