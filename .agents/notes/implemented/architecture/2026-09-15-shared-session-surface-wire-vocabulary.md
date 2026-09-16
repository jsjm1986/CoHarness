# Agent Note: The session surface wire vocabulary is single-sourced

Status: implemented

English | [中文](2026-09-15-shared-session-surface-wire-vocabulary.zh.md)

## Problem

Three raw-event intake boundaries each kept a private copy of the surface-event vocabulary: the runtime session's envelope validation, the Gateway's `conversationEvents` append ingress, and the session-persistence Gateway adapter's response validation. Mirrored literals diverge silently: the Gateway's copy predated `system/message` surface eligibility and accepted only the legacy `start`/`end` replace keys, so production appends carrying a `system/message` with `surfaceOp` — or a canonical `startSeq`/`endSeq` replace — were rejected with a generic persistence error, leaving the session readable but uncontinuable.

## Decision

`@deepseek-ai/dsh-session-format/surface` owns the wire vocabulary as a pure module beside the format version it describes: `SESSION_SURFACE_EVENT_TYPES` lists the four surface event types, `isSessionSurfaceEventType` tests membership, and `isSessionSurfaceOp` accepts `'append'`, the canonical `{ op: 'replace', startSeq, endSeq }`, and the legacy `{ op: 'replace', start, end }` committed generations still carry. Every intake boundary consumes the shared module: `core/session`'s surface eligibility, the Gateway's envelope validator, and the persistence adapter's response check. An event type outside the build's known vocabulary that carries `ignorable: true` keeps opaque `surfaceOp`/`sourceEventSeqs` on every boundary, matching the adoption rule in [canonical session-event ingress](2026-09-14-canonical-session-event-ingress.md); current-format surface metadata on ordinary log events still rejects.

## Alternatives considered

**Keep per-boundary copies.** Rejected: the copies already diverged in production, and each divergence rejects valid events with a generic error far from the cause.

**Own the vocabulary in `core/session`.** Rejected: the Gateway and persistence adapter validate raw wire events without a Session, and the vocabulary describes the wire format, so it belongs in the format package all three boundaries already depend on.

**Share types only.** Rejected: the divergence lived in runtime literals — `Set` membership and replace key-pair checks — which type declarations cannot pin.

## Consequences

Adding a surface event type or a replace-key pair touches one module, and every boundary accepts the same events by construction. The module is pure wire format with no shared runtime identity, so the client bundle purity gate admits the subpath through `INLINE_SAFE` while the bare package stays external. Validation strength is unchanged: malformed current-format events, stray envelope keys, and surface metadata on known non-surface events still reject on every boundary, and legacy-generation bodies keep reading under the relaxed consistency rule.

## Verification

`gateway/tests/runtime-api.spec.ts` covers `system/message` with `surfaceOp`, canonical replace acceptance, the ignorable exemption, and each rejection rule. `packages/session/session-format/tests/surface.spec.ts` pins the vocabulary, and `packages/session/session-persistence-gateway/tests/gateway.spec.ts` covers legacy relaxation plus strict current-format rejection.
