# Agent Note: CoHarness v0/v1 Session dialect admission

Status: proposed

English | [中文](2026-09-25-coharness-v0-v1-session-dialect.zh.md)

## Problem

The alpha.2 durable-layer re-platform routes stored Sessions through `sessionLogicalFormatCatalog`, whose migration edges apply released vocabulary at each generation. Gateway-written SQLite/PostgreSQL Sessions recorded members the released v0/v1 key sets never named. A read-only scan of the production conversation store showed 61 of 90 Sessions refusing migration: `permission/preset.origin` (`default`/`selection`/`inferred`), `subagent/descriptor` stamped `version: 2`, message `source.documents` attachment lists, `source.participant.scope.canManage`, and the `userdoc/attached` event type, which no released generation classifies at all.

The same events re-break at each later edge they cross: `permission/preset` keys are asserted again inside the v2 stage's `assertEvent`, and the released v1→v2 stage refuses unknown event types outright. Members cannot simply ride through, and they must not be dropped — every one of them is live vocabulary in the current schema.

## Proposal

Extend the declared-dialect mechanism the v2 edge already uses to the v0 and v1 edges, with one shared member ledger:

- `coharness-dialect-members.ts` hides dialect members before released admission and re-attaches them to the emitted event. `permission/preset.origin` and `source.participant.scope.canManage` are validated then re-attached; `source.documents` is hidden only on `kind: 'user'` sources where the released key assertion applies; `subagent/descriptor` `version: 2` is rewritten to 3 because the v3 schema froze an identical field set.
- `coharness-v0-dialect.ts` wraps the released v0→v1 stage, which emits exactly one event per admitted input in order, so a FIFO ledger re-attaches deterministically.
- `coharness-v1-dialect.ts` wraps the released v1→v2 stage; member-bearing types emit one-to-one in order there as well, and a type-matched head ledger restores on the emit boundary.
- Dialect-only types (`userdoc/attached` in its declared `version: 1` form) bypass released admission entirely, emit in place, and receive their output position at the v2 dialect edge, which skips density and citation-mapping writes for them — nothing references their seqs, and the released stages' renumbering cannot admit them.
- The v2 dialect stage runs the same hiding before `assertEvent` and restores inside `emitMapped` keyed by source seq, covering members arriving from earlier edges and sessions stored at v2 directly.

Malformed dialect payloads still refuse: unknown origins, undeclared `userdoc/attached` shapes, and descriptor versions outside the declared stamp fail loudly rather than widening admission.

## Alternatives considered

**Relax the released v0/v1 key sets to name the CoHarness members.** This widens upstream admission for every consumer, including physical JSONL reads that never produced these members, and forks the released validators the re-platform adopted verbatim.

**Drop the members during migration.** `origin`, `documents`, `canManage`, and `userdoc/attached` are live vocabulary in the current schema; discarding them silently degrades stored Sessions the current runtime still consumes.

**Migrate by editing stored rows.** Session data follows the immutable-generation rule; rewriting committed rows conflates normalization with storage mutation and loses the ability to distinguish what was stored from what the chain produced.

## Acceptance criteria

- Every stored database Session previously refused only for declared dialect members migrates through `finish` validation; the production store reaches 90/90.
- Malformed dialect payloads — undeclared origins, descriptor stamps, `userdoc/attached` shapes, unknown types — still refuse.
- The physical catalog retains released-only admission; no dialect member leaks into JSONL artifact reads.

## Risks

A member restored after a released edge is no longer re-validated downstream; the dialect stages validate each member before hiding so a malformed dialect payload cannot ride through. Dialect-only events occupy output positions the released stages never numbered; the v2 stage's density skip is scoped to declared dialect types only, so a new unknown type cannot exploit the gap. A future released edge that renumbers by emitted order must re-key the source-seq ledger before the v2 restore lookup.

## Consequences

- All 90 stored database Sessions read through the logical catalog; 61 previously refused now migrate, including the largest production projects' histories.
- The physical catalog keeps released-only admission: JSONL artifacts were always written in released vocabulary (146 v0 files verified), so the dialect stays a logical-path concern.
- One known-bad artifact remains: a header-only `session.v2.jsonl.zstd` written before `isSeeded` existed fails the released v2 physical header and stays unreadable; it holds zero events and nothing migrates it.
- The implemented replatform note's statement that only the v2 edge runs dialect admission is updated in place.

## Verification

- Read-only scan of the production conversation store: 90/90 Sessions migrate through the chain's `finish` validation (was 29/90).
- `vitest run packages/session/session-format-catalog`: 147 tests pass, including nine new cases covering `origin` preservation at v0 and v1, descriptor stamp rewriting, `documents`/`canManage` round-trips on direct and inserted sources, `userdoc/attached` carry-through, and refusal of undeclared origins, descriptor versions, `userdoc/attached` shapes, and unknown types.
- `vitest run packages/session/session-persistence`: 200 tests pass.
