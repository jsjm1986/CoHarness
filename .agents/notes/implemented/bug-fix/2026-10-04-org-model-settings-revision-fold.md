# Agent Note: Fold organization model-settings writes through the describe mirror

Status: implemented

English | [中文](2026-10-04-org-model-settings-revision-fold.zh.md)

## Problem

The admin organization models editor created a `SettingsDescribeMirror` over the REST facade but never folded write answers through `acceptView`, and organization settings plus credential writes share one server-side `model_configuration_revision`. Every successful mutate or credential write left the mirrored `namespace.revision` stale, so the next `expectedRevision` write self-conflicted with a 409 until the editor remounted — no concurrency required. Separately, the shared provider editor let an organization provider's `models` be emptied (the org validator rejects `models: []`), the row-level `PUT /admin/api/model-providers` accepted a `profile` field it silently dropped, and the Usage quota dialog skipped the safe-integer check its sibling pages apply to cost micros.

## Decision

`createOrganizationModelsMirror` returns the `{ describeFace, api }` pair: mutate answers fold their returned namespace through `acceptView`, a `settings-conflict` answer triggers `describeFace.load()` so a retry carries the real revision, and credential set/unset trigger the same load because they bump the shared revision without returning a view. The shared `ProviderEditor` treats an owned empty `models` array in `credentialScope: 'organization'` as a submit-blocking failure (`providerModelsRequired`) pointing at the delete-provider affordance. The model-providers row route rejects a `profile` field explicitly — profiles are written only through `/admin/api/model-settings`, so forwarding one would desynchronize section from catalog. `UsagePage` applies the same `Number.isSafeInteger(costMicros)` guard as the detail pages.

## Files

- `gateway/admin-ui/src/model-settings-api.ts` — `createOrganizationModelsMirror` folds write answers and refreshes on credential writes and conflicts.
- `gateway/admin-ui/src/components/OrganizationModelsEditor.tsx` — consumes the mirror/facade pair.
- `packages/client/ui-settings-models/src/client/ProviderEditor.tsx` + `locales.ts` — owned empty `models` blocks submit in organization scope.
- `gateway/src/admin-api.ts` — row route rejects `profile` with a pointer to `/admin/api/model-settings`.
- `gateway/admin-ui/src/api.ts` — `ModelProviderInput` drops the silently ignored `profile` member.
- `gateway/admin-ui/src/pages/UsagePage.tsx` — safe-integer guard on cost micros.

## Consequences

A REST facade wrapped in a describe mirror must fold every write answer that can move the shared revision, including credential writes that return no view. Fields that an endpoint cannot honor are rejected at the route, not dropped.
