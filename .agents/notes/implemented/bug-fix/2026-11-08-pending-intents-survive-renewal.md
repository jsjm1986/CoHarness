# Agent Note: Pending conversation intents survive same-account renewal

Status: implemented

English | [中文](2026-11-08-pending-intents-survive-renewal.zh.md)

## Problem

`verifiedAccountId` revokes for the whole unverified renewal interval (deliberate since `371a539a490`: the interval owns no private scope). The pending-intent subscriber treated *any* policy change as an account change, so every transport renewal — socket refresh, focus re-verification, SSE reconnect — ran `7 → undefined → 7` and wiped in-flight conversations plus their typed drafts, which the `personal-computers` transport-renewal scenario is written to protect.

## Decision

[runtime/src/client/index.ts](../../../../packages/client/runtime/src/client/index.ts) clears pending intents only when a *different verified* identity arrives. A bare revocation (`next === undefined`) is the unverified window, not an account change: intent text is user-authored local input, not fetched private data, so it stays editable while re-verification is pending. A genuine account switch still clears (`7 → undefined → 8`), and the identity fence's `onPrincipalChange` disposes the whole fiber for a real principal change.

The related catalog fix: the remote workbench directory is authoritative only in verified multi-computer mode ([WorkbenchToolbar.tsx](../../../../packages/client/ui-workbench/src/client/components/WorkbenchToolbar.tsx)). A single-node surface has no `/account/api` routes at all, so when `readCatalog` exists but the deployment context has not verified `mode === 'multi'`, the local session store is the complete picker source. Routing the picker to a nonexistent gateway left it permanently empty.

## Alternatives considered

**Keep clearing on every revocation.** Rejected: it makes the renewal-survival contract unimplementable — any transient refetch destroys typed input.

**Restore the pre-merge `documentIdentityOwned` gate** (skip `setVerifiedAccountId(undefined)` while a fence exists). Rejected: `371a539a490` deliberately removed it so the unverified interval owns no private scope, and `plugin.client.spec.ts` asserts revocation during renewal.

**Keep directory `prewarm`.** Rejected and reverted (`8e493aac7e4`): warming every granted computer's row page violates the cold-computer contract — unused runtimes must receive zero requests, passive reads included.
