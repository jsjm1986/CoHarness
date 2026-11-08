# Agent Note: Pending conversation intents survive same-account renewal

Status: implemented

English | [中文](2026-11-08-pending-intents-survive-renewal.zh.md)

## Problem

`verifiedAccountId` revokes for the whole unverified renewal interval (deliberate since `371a539a490`: the interval owns no private scope). Three policy subscribers treated *any* identity change as an account change (pending-intent clear, personal-directory account-lifetime reset, viewport navigation supersession), and a fourth killed the same pending prepare differently: `ui-workspace` bundled `sessions.beginNavigation()` into the prepare's abort set, so the session re-open a renewal replays superseded the in-flight signal — each path flipping the surviving intent to `unavailable`. Every transport renewal — socket refresh, focus re-verification, SSE reconnect — ran `7 → undefined → 7` and hit them, which the `personal-computers` transport-renewal scenario is written to protect.

## Decision

[runtime/src/client/index.ts](../../../../packages/client/runtime/src/client/index.ts) clears pending intents only when a *different verified* identity arrives, and [personal-directory.ts](../../../../packages/client/runtime/src/client/personal-directory.ts) applies the same rule to its account lifetime: both keep the last verified identity through a bare revocation (`next === undefined`), because that is the unverified window, not an account change. Intent text is user-authored local input, not fetched private data, so it stays editable while re-verification is pending, and the pending restore whose prepare signal embeds `accountLifetime` is not aborted mid-flight, and [ui-conversation's viewport](../../../../packages/client/ui-conversation/src/client/viewport.ts) applies the same rule to navigation supersession: a bare revocation clears private persistence scope but never calls `sessions.beginNavigation()`, so the pending input's navigation signal survives the interval. In [ui-workspace](../../../../packages/client/ui-workspace/src/client/index.ts) the prepare's abort set keeps only `editing` (the intent's own controller — `hide`/`clear` still cancel on real user navigation) plus fiber lifetime and the caller's signal; `beginNavigation()` is removed because supersession is a view fact, not intent death — `commitOpen`'s transfer check already decides whether the intent still owns the landing. A genuine account switch still clears (`7 → undefined → 8`), and the identity fence's `onPrincipalChange` disposes the whole fiber for a real principal change.

The related catalog fix: the remote workbench directory is authoritative only in verified multi-computer mode ([WorkbenchToolbar.tsx](../../../../packages/client/ui-workbench/src/client/components/WorkbenchToolbar.tsx)). A single-node surface has no `/account/api` routes at all, so when `readCatalog` exists but the deployment context has not verified `mode === 'multi'`, the local session store is the complete picker source. Routing the picker to a nonexistent gateway left it permanently empty.

## Alternatives considered

**Keep clearing on every revocation.** Rejected: it makes the renewal-survival contract unimplementable — any transient refetch destroys typed input.

**Restore the pre-merge `documentIdentityOwned` gate** (skip `setVerifiedAccountId(undefined)` while a fence exists). Rejected: `371a539a490` deliberately removed it so the unverified interval owns no private scope, and `plugin.client.spec.ts` asserts revocation during renewal.

**Keep directory `prewarm`.** Rejected and reverted (`8e493aac7e4`): warming every granted computer's row page violates the cold-computer contract — unused runtimes must receive zero requests, passive reads included.

## Consequences

A pending intent or typed draft survives any number of transport renewals while the document still belongs to the same account, and disappears exactly when a different verified account arrives or the fence tears the fiber down. The picker on a single-node deployment reads only the local session store, so `/account/api` absence can no longer strand it empty; verified multi-computer deployments keep the remote directory as their source of truth.

## Verification

The `personal-computers` transport-renewal scenario holds a conversation open through `renewEventStreams` and asserts the pending intent and its draft remain editable. The scoped NodeDraft suite in `ui-conversation` covers owner categories, suspension replay, and legacy-copy migration at per-file 100% coverage.
