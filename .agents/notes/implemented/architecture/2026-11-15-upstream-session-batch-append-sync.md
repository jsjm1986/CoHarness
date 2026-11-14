# Agent Note: Upstream Session batch append sync

Status: implemented

English | [中文](2026-11-15-upstream-session-batch-append-sync.zh.md)

## Problem

Upstream v0.2.2-rc.3 extended `Session.append` to accept an array of
positional event inputs that commit atomically before publication. The local
Session only appended one event per call, and its `appendAdmissions`
reservation protocol and `session/created` announcement guard are local
lifecycle divergences the upstream batch path does not know.

## Decision

- `Session.append(inputs: readonly SessionEventInput[])` validates every
  candidate and dispatch first — snapshots, `assertSupportedRequestHeader`,
  canonical payload validation, every registered append admission, and
  `surfaceManager.prepareBatch` over an isolated fold — then pushes all
  members, adopts the validated surface, and publishes them in order.
  `session.currentBatchPublication` names the member being delivered;
  `session.seq` and `session.surface` already include the complete batch
  when the first observer runs.
- Append admissions run per member before any commit; a refusal or later
  validation failure rolls back successful reservations in reverse order,
  so a rejected batch reserves nothing and appends nothing.
- `planSurfaceEvent` gained an optional `candidates` context and reads
  referenced sequences through a `read(seq)` closure spanning
  `[...log, ...candidates]`, so batch members may cite earlier members of the
  same append (developer headers, replacement `sourceEventSeqs`, tool-result
  rewrites); the slow path folds batch-internal effects on a cloned state.
- Single-event append keeps its signature and reuses the shared
  `snapshotAppend`/`createAppendEvent` helpers; reentrancy, announcement,
  detach, and `session/created` guards are unchanged.

## Consequences

- Upstream callers that batch appends work unchanged; listeners written for
  the upstream contract can rely on `currentBatchPublication` and a
  complete log at first observation.
- Batch admission failures are all-or-nothing identical to single append.
- Batch members may legally reference each other's seqs, which single-append
  callers could never express.

## Alternatives considered

- Ported with `appendAdmissions` only at batch granularity (one reservation
  covering the whole array) — rejected: admissions reserve per candidate
  resource, and per-member rollback already composes cleanly.
- Keeping upstream's detach without the `announcement !== 'dispatching'`
  guard — rejected: the local announcement four-state makes a detach during
  dispatch illegal; the batch path keeps the local guard.

## Verification

- `packages/core/session/tests/append.spec.ts` (upstream suite plus a local
  admission-rollback case): 14 tests — sparse arrays, option handling,
  same-batch replacement, getter reentrancy, dispatch veto, detach after
  last publication, admission rollback.
- Session + session-persistence suites: 3618 tests pass; agent-loop resume
  and request-reconstruction and apiproxy fork suites green.
- `gen-cordis-catalog` regenerated the `session/event` docs; package README
  pair and `verify-translation-pairing` re-recorded.
