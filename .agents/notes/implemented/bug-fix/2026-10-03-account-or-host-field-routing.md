# Agent Note: Route account-or-host settings writes by field whitelist

Status: implemented

English | [中文](2026-10-03-account-or-host-field-routing.zh.md)

## Problem

`AccountOrHostSettingsScopeController` sent every field write of a namespace to the account preference endpoint, but `PATCH /account/api/preferences` accepts a fixed field whitelist (`preference` for `locale`/`ui-theme`; `busyEnter`, `chatContentWidth`, `chatFullWidth`, `chatFontSize` for `ui-conversation`). Fields owned only by Host settings (`transcriptView`, `performanceUsage`, `linkOpening`) were rejected with 400 `invalid-account-preference`, and because all rows of a namespace share the scope's write state, one rejected field painted the whole section "save failed". Reads showed account-side defaults instead of the stored Host values for the same fields.

## Decision

The composite routes each `set`/`unset` through `ACCOUNT_FIELDS`: whitelisted fields go to the live source (account, or Host after a 404/501 fallback), every other field goes to the Host scope directly. The Host subscription stays installed while the account layer is active, and the published snapshot merges both sections: `value`/`base`/`user` take the account layer for whitelisted keys and the Host layer for the rest, while `write` surfaces the more urgent of the two write states (error > blocked > saving > idle). `ACCOUNT_FIELDS` lives in `account-scope.ts` beside the mirror's namespace projection, which already hardcodes the same wire contract; the client bundle purity gate forbids sharing the constant with `dsh-client-connection`.

## Files

- `packages/client/ui-settings/src/client/account-scope.ts` — field routing, dual subscription, merged snapshot layers.
- `packages/client/ui-settings/src/client/settings-scope.ts` — passes `spec.namespace` to the composite.
- `packages/client/ui-settings/tests/account-scope.client.spec.ts` — routing and merge regressions.

## Consequences

Settings rows backed by `account-or-host` write Host-only fields through the Host settings document; genuine Host write failures still surface as the row error state. Adding a field to the account endpoint whitelist requires updating `ACCOUNT_FIELDS`, the `AccountPreferenceMutation` union, and the mirror namespace projection together.
