# Agent Note: Session-scoped credential commit for authorization flows

Status: implemented

English | [中文](2026-10-01-authorization-session-scoped-commit.zh.md)

## Problem

`AuthorizationService` released a credential key the moment the caller-visible outcome was known. A withdrawn attempt's flow kept running unsupervised with the key freed: a pi-ai login that reached its store write after the caller cancelled still published the grant it had just earned, and a second `begin()` could start while the first flow's write was still pending. Commit evidence came from watching `credentials/record-updated` during the run, so any same-key write — not necessarily the flow's own — satisfied the `NOT_COMMITTED` check.

## Decision

`AuthorizationSession` carries `commit(mutate)`, a serialized read-modify-write fixed to the flow's own `CredentialKey`; it is the only write the seam accepts as the attempt's commit. The attempt tracks an `active | committing | committed` phase. Admission is guarded at queue entry, again inside the credential provider's exclusive mutation (the write may have queued behind an unrelated operation), and once more before the replacement returns to storage — where the phase turns `committing` synchronously. `committed` is earned only by a fulfilled storage operation: a mutation that declines with `undefined` hands the provider `undefined`, so the read path returns the current record without a write, and a no-op can never masquerade as a commit.

Withdrawal is closed once admission closes. The request signal, `cancel(key)`, and flow-registration disposal abort the attempt's signal only while the phase is `active`; an admitted write finishes on its own terms — `authorized` when storage fulfills, or the attempt fails with the storage error, cause preserved, settlement `failed`. Nothing reads record presence as success and nothing silently absorbs an admitted write's rejection.

Cancellation splits the caller's answer from the reservation. A withdrawn caller hears `cancelled` immediately, but `running` keeps the key until the orphaned flow and its queued commit work actually quiesce — a settled flow does not release queued writes — and `authorization/settled` fires once, after that release. A captured session cannot write after withdrawal, flow settlement, or release: `commit` rejects with `WITHDRAWN` at every checkpoint.

The pi-ai adapter's `credentialStoreFrom(ctx, { modifyRecord })` accepts an optional serialized-write delegate; a login collection builds it with a closure that refuses any key but the flow's own and delegates to `session.commit`. `Models.login` remains the single login orchestrator — its `store.modify` is the commit, not a copy persisted twice. The adapter also honors pi-ai's `AuthOperationOptions.signal` at operation start and inside `modify`'s mutation checkpoints.

## Alternatives considered

**Keep releasing the key at the caller's answer and abort the orphaned write.** Rejected: the seam cannot cancel work already inside the credential provider's exclusive mutation, and second-begin-while-writing is exactly the double-write race the key reservation exists to prevent.

**Let the flow hand its credential back and have the seam persist it.** Rejected: a library that persists through its own store adapter (pi-ai's `Models.login()`) would write once inside the library and again through the seam — two writers, two orderings, and a stale refresh could interleave between them.

**Keep the `credentials/record-updated` watcher as commit evidence.** Rejected: the event proves a write happened, not that this attempt wrote; an unrelated same-key write would satisfy `NOT_COMMITTED` for a flow that committed nothing. Only the session's committed mark is authoritative.

## Consequences

Flows must commit through `session.commit` — a direct `ctx.credentials.modifyRecord` during `run()` no longer counts, and flows that wrote that way fail `NOT_COMMITTED` until migrated. An uncooperative flow that ignores its signal now holds the key for as long as it runs rather than being cut loose; that is the price of never publishing a withdrawn write. `authorization/settled` for a withdrawn attempt arrives late by design — watchers that start a follow-up attempt must tolerate the delay.

## Testing

[authorization.spec.ts](../../../../packages/credentials/authorization/tests/authorization.spec.ts) covers admission refusal, queued-write cancellation, mid-mutation withdrawal, admitted-write completion and storage failure under a held store (through the request signal, `cancel`, and registration disposal alike), reservation outliving a settled flow's queued commit, no-op mutation behavior, unrelated writes, and disposal. [login-lifecycle.spec.ts](../../../../packages/llm/llm-pi-ai/tests/login-lifecycle.spec.ts) runs the real `Models.login` through a Loader composition with a gated credentials provider and a controlled OAuth provider — including a proven queued-behind-another-operation write and an admitted write whose storage fails — and [auth.spec.ts](../../../../packages/llm/llm-pi-ai/tests/auth.spec.ts) pins the adapter's signal checkpoints and write serialization.
