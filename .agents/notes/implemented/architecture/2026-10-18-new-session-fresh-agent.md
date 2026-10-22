# Agent Note: Bare New Session mints a fresh Session+Agent under the current preset

Status: implemented

English | [中文](2026-10-18-new-session-fresh-agent.zh.md)

## Problem

The upstream `new-session-generations` change makes Web/Desktop New Session create a fresh Session and Agent under the current preset definition. The fork's `WorkspaceRuntime.startSession` delegated every call to `connectWorkspace`, which reuses the Workspace's first eligible blank member — a Session minted under an earlier gesture keeps the composition it recorded, so a New Session click after a preset change reopened a stale generation instead of the current one.

The fork also carries state upstream does not: durable draft reservations pair a `draftId` with a preallocated `sessionId` per Workspace, and the pooled runtime qualifies Session identities as browser keys. Naming a parked reservation's `sessionId` on a bare start adopts its persisted blank — which resumes under the composition the reservation recorded — so fresh semantics require sending `session.create` with the Workspace identity alone.

## Decision

**`startSession` splits into two arms.** A call carrying `prompt` or `clearPreviousDraft` keeps the draft-preparation semantics of [blank-Session preset reuse](2026-10-16-blank-session-preset-reuse.md) and routes through `connectWorkspace` — member-blank scan, reservation adoption, and draft hand-off unchanged. A call carrying neither routes through `connectFreshSession`, which sends `session.create` with only `workspaceId`: the Host mints the identity and composes the Agent itself, so no member blank or reservation generation can leak the earlier preset.

**The bare arm owns a separate in-flight generation.** Concurrent bare calls for one Workspace coalesce on the same `session.create`; a reuse connect never joins it, because a resolved blank could satisfy the reconnect contract but not the fresh-preset one. The discriminator is the draft options, not options-object presence: the UI layer always supplies `onFailure`, so `options === undefined` can never express a bare call.

**Existing Agents keep their composition.** Only Session birth composes; a preset edit or bundle switch leaves live Agents untouched, and global optional tools refresh on the affected Agent's next request. A reused blank is still a [reuse-arm](2026-10-16-blank-session-preset-reuse.md) switch under the request's preset — bare starts simply never produce one.

## Alternatives considered

**Send the parked reservation's `sessionId`/`draftId` on the bare create.** Rejected: naming the reservation adopts its persisted blank under its recorded composition — the exact stale-generation outcome the change removes — and would mint no new generation.

**Reuse a member blank and switch its preset in place.** Rejected: `reuseWorkspaceBlank` exists for the reconnect arm where reopening the same Session is the point; a New Session that lands on an already-listed row also resurrects its draft state instead of starting empty.

**Discriminate on `options === undefined` like upstream.** Rejected: the fork's `UiWorkspace.startSession` always wraps a failure observer into the options object, so the field contents — not the envelope — distinguish draft preparation.

## Consequences

`connectWorkspace` keeps its contract as the Workspace-reconnection arm (`openWorkspace` fallback, startup restore, draft-prepared starts); its reservation lifecycle, pooled-identity decode, and per-preset coalescing are untouched. Each bare New Session click persists a new durable Session: repeated gestures no longer collapse into one provisional row, and a reload keeps every minted generation in the list.

Regression coverage lives in `packages/client/runtime/tests/workspaces-service.client.spec.ts` (bare arm ignores the member blank and parked reservation, in-flight coalescing stays arm-scoped, draft-prepared starts still reuse) and `apps/web/tests/blank-preset-reuse.e2e.ts` (shipped-composition fresh mint past a parked `minimal` member, existing-Agent preservation).

## Verification

`packages/client/runtime` workspaces suite — 55 tests. `apps/web` (built host+client bundles): `blank-preset-reuse.e2e.ts` — 4 tests through the real Loader composition; `workspace-history-entry.e2e.ts` — repeated bare gestures mint new durable Sessions.
