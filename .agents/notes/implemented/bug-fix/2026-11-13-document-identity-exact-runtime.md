# Agent Note: Document identity carries the exact runtime allocation

Status: implemented

English | [中文](2026-11-13-document-identity-exact-runtime.zh.md)

## Problem

On a multi-node fleet the managed web client could never finish boot: every `/` navigation is redirected to `/?dshRuntime=<id>` by the landing resolver, but `__DSH_DOCUMENT_IDENTITY__` embedded only a scope-level target (`{kind:'personal'}` or `{kind:'project',projectId}`). The browser identity fence treats a bootstrap `dshRuntime` whose exact allocation the document target does not carry as an account-change (`setRuntimeTarget` requires `target.runtimeId` to equal the pinned id), so `installConnection` threw `BrowserIdentityChanged` during `apply`, `dsh-client-connection` failed, all 57 UI entries stayed pending, and `invalidate()` reloaded the page into the same failure — an infinite boot loop with a blank page.

Even without an explicit selector the failure was total: the fence pins scope-sensitive requests with `dshTarget=personal`, and the catalog correctly answers `runtime-catalog/ambiguous-target` (HTTP 409) once an account owns more than one runtime in the same scope kind across nodes, so every `/api/*` call failed. Only accounts with exactly one runtime per scope kind ever booted, which is why the defect survived single-node validation.

## Decision

The document identity now carries the exact runtime allocation the authenticated index response selected, end to end:

- [GatewayRuntime](../../../../packages/context/gateway-runtime/src/index.ts) spreads `claims.runtime.runtimeId` into the injected `__DSH_DOCUMENT_IDENTITY__.runtimeTarget` when the verified claim names an exact allocation; legacy single-assignment compositions keep the scope-only target.
- [parseDocumentIdentity](../../../../packages/client/connection/src/client/document-identity.ts) accepts an optional non-empty-string `runtimeId` on either target kind and detaches it into `ClientRuntimeLocation`; unknown target keys, empty or non-string runtime ids, and authority-bearing fields are still rejected.

The fence then pins every scope-sensitive request and socket with `dshTarget=<scope>&dshRuntime=<exact id>`, matching the already-declared `host.describe.runtimeTarget` wire schema and the runtime-side `describe` emission, so the bootstrap handshake re-confirms the same allocation instead of invalidating it.

## Alternatives considered

**Drop the `dshRuntime` bootstrap check.** The check is the identity fence's protection against an HTML document bound to a different runtime than the URL advertises; removing it lets a stale or replayed document silently pin another allocation.

**Emit `runtimeId` only when the URL carries `dshRuntime`.** The identity must describe the answering runtime, not the request text; a catalog-resolved landing (bare `/`) needs the same exact pin for subsequent ambiguous-catalog requests.

**Resolve `dshTarget=personal` to the home node.** Ambiguity is the catalog's correct answer when several allocations own the scope; synthesizing a preference would pin arbitrary runtimes and diverge from `resolveForAccount` semantics.

## Consequences

Multi-node fleets boot the managed web client for every account and every runtime density; scope-level pins remain the fallback only for runtimes launched without an allocation id. The same `runtimeId` now arrives through three channels (document identity, `host.describe`, request pins), all compared by `runtimeTargetKey`, so a mismatched hop still invalidates the document instead of drifting.

## Verification

- `gateway-admission.host.spec.ts` renders `{kind:'personal',runtimeId}` for a claimed allocation and keeps scope-only targets for legacy claims.
- `document-identity.client.spec.ts` accepts runtimeId-bearing targets and rejects malformed or extra-key input.
- Deployed fleet: `https://harness.maycran.com/?dshRuntime=<id>` served `runtimeTarget:{kind:'personal',runtimeId:<id>}` and Chrome booted the full UI — sidebar node list, sessions, workbench — in place of the previous `web boot: 57 entries did not activate` loop.
