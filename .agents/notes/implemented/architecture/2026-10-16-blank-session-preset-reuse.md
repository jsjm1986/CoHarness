# Agent Note: Blank Sessions reuse under the requested preset, never the recorded one

Status: implemented

English | [中文](2026-10-16-blank-session-preset-reuse.zh.md)

## Problem

Upstream PR #5460 and commit `3c1e3571329f` fixed a deadlock: a blank Session whose recorded Agent preset was later deleted could never be opened — every resume resolved the recorded composition and failed `agent-preset-not-found`. The local fork had the same failure plus a split the upstream UI layer does not have: `session.create` names a Session either as an adoption (replay history under the recorded preset) or as a Workspace blank-reuse candidate, and those two semantics must not blur.

## Decision

**Named adoption preserves history; `reuseWorkspaceBlank` runs the request.** A wire `sessionId` alone stays an adoption — the resumed Session keeps the composition its log recorded because its turns replay against it. The `reuseWorkspaceBlank` flag declares the named Session a reuse candidate: it runs the request's `agentPreset`, or the deployment default when none is named or the named one is no longer declared. A blank has no turns to replay, so nothing binds it to a stale composition.

**A declined candidate is replaced, not repaired.** The Host re-verifies blankness under the acquired writer; a candidate that filled, lost its writer, or rejects the switch throws `BlankReuseDeclined`, which the concurrent-creation recovery rethrows before generic live-agent adoption can swallow it. The create command then mints a fresh identity under the same request — migrating any draft reservation — and attaches that instead.

**`agentPresets.select` is idempotent.** When the log already records the requested preset and the Agent still binds its current generation, `select` returns without recomposing, logging, or announcing. Per-session serialization keeps a stale blankness read from interleaving two swaps.

**Preset requests do not coalesce across in-flight connects.** `connectWorkspace`/`openWorkspace` accept `{ agentPreset }`; the in-flight map joins only requests naming the identical preset (omitted and named are distinct), and stale attempts cannot delete a newer map entry. A `agent-preset-not-found`/`agent-preset-invalid` response triggers exactly one retry without `agentPreset`. A declined reuse that returns a different identity re-pulls the session list because cached blank metadata hid the now-filled row.

**Startup restores a saved blank through the same reuse arm.** A persisted `dsh.sessions.current` naming a Workspace-member blank calls `sessions.create` with `reuseWorkspaceBlank` and the summary's `agentPreset` — the client list's log-resolved value, not the header — so an undeclared recorded preset degrades to the default on retry.

**Cold-list preset truth comes from the probe that already paid for it.** `summarizeCold` resolves `agentPreset` from folded probe events (`sessionListFields`) when the bounded blank probe read the log; an unprobed large artifact stays header-only because the switch fact is not worth a full read.

## Alternatives considered

**Treat every named Session as a reuse candidate like upstream's folded create.** Rejected: upstream's UI cannot name an arbitrary Session to adopt; the local wire can, and adoption must preserve recorded composition for nonblank history.

**Keep header `agentPreset` as the cold-list value.** Rejected: a blank that switched presets leaves the header stale, and the startup restore reads the summary. The probe already holds the events, so log-derived truth costs nothing there.

**Retry the failing preset inside the Host.** Rejected: the typed `agent-preset-not-found`/`agent-preset-invalid` codes already exist; the single client retry keeps the wire contract honest and leaves the failure visible to other callers.

## Consequences

`session.create` accepts `agentPreset` and `reuseWorkspaceBlank`; `SessionsPort` exposes `create` and `agentPreset` on its summary; `SessionRuntimePool.create` translates pooled identities both ways. The draft arm keeps the recorded preset with a default fallback, preserving draft-restore semantics. Live blank switching appends `agent-preset/selected` so the log — not the header — is the projection source of truth.

Regression coverage lives in `packages/host/apiproxy/tests/api-proxy-agent-preset.spec.ts` (reuse arm, decline-and-mint, live switch), `api-proxy-cold.spec.ts` (probe-derived preset), `packages/client/runtime/tests/workspaces-service.client.spec.ts` (preset forwarding, retry, refresh, per-preset coalescing, startup restore), and `apps/web/tests/blank-preset-reuse.e2e.ts` (shipped-composition reuse and restore under declared and undeclared presets).

## Testing

`packages/host/apiproxy`: agent-preset and cold suites — 59 tests. `packages/client/runtime`: workspaces and sessions suites — 96 tests. `apps/web` (built host+client bundles): `blank-preset-reuse.e2e.ts` — 3 tests through the real Loader composition.
