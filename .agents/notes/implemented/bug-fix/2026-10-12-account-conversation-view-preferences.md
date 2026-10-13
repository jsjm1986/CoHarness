# Agent Note: Account preferences carry every ui-conversation field

Status: implemented

English | [中文](2026-10-12-account-conversation-view-preferences.zh.md)

## Problem

The `ui-conversation` settings namespace is registered `owner: 'account'` with `projectWrite: 'never'`, and the browser binds it through the `account-or-host` scope so each member's display choices persist per account even inside a shared project runtime. The account-preference wire contract, however, accepted only `busyEnter`, `chatContentWidth`, `chatFullWidth`, and `chatFontSize`. The three later additions to the schema — `transcriptView` (work-details presentation), `performanceUsage`, and `linkOpening` — never entered `AccountPreferenceMutation['field']`, `ACCOUNT_FIELDS`, the Gateway validator, or the `harness.user_preferences` table.

In a project scope the merged scope still reported the namespace writable because the account leg was active, but `route()` sent those fields to the Host scope, which refuses account-owned writes for project participants. The row therefore rendered its selector as enabled, the selection appeared to take, and the write ended `blocked` with the "account storage is currently read-only" notice — a silently ineffective preference, exactly the failure shape the chat-full-width note warns about when a field lags the account path.

## Decision

The account-preference contract now carries the complete `ui-conversation` field set. Migration `055_conversation_view_preferences.sql` adds nullable `transcript_view`, `performance_usage`, and `link_opening` columns with check constraints matching the writable modes. The Gateway type union, `normalizeAccountPreferenceMutation`, the Postgres service's row projection/mutation map/legacy reader, the browser transport's field union and parsers, and `ACCOUNT_FIELDS` all accept the three fields. Legacy `settings.yaml` values migrate with the schema's own folding: `normal` and `expanded` transcript modes store as `detailed`, the same presentation the Host schema already reads them as.

Unset clears to NULL and the values view returns the product defaults (`detailed`, `detailed`, `sidebar`), so every surface sees one effective value regardless of which layer answered. With all seven schema fields whitelisted, the account leg is authoritative for the whole namespace; the Host layer now contributes only keys the endpoint does not own.

The shared `Modal` primitive is what let the broken state hide: the prop documentation already promised a scrollable `contentClassName` region, yet `overflow-y: auto` existed only inside the compact media query and `.dialog` had no desktop height bound. Desktop dialogs taller than their content cap clipped the body into the footer. The base rules now bound the card to the padded viewport and scroll `.content` on every viewport while `.footer` stays pinned.

## Alternatives considered

**Leave the fields Host-routed and polish the read-only copy.** The ownership metadata already calls these preferences account-owned; a project member locked out of a personal display preference is the wrong product answer, and the account channel exists precisely to write account data under a shared project runtime.

**Relax `projectWrite` for the namespace.** Writing member-specific values into the shared project settings document would leak one member's preference to every other member and contradicts `owner: 'account'` outright.

**Extend the wire contract without a migration.** A JSONB preferences blob would skip the DDL step but abandons the established per-field column/check-constraint pattern that migrations 020/023/026 already set, and loses the single-statement fenced update the revision model relies on.

## Consequences

`transcriptView`, `performanceUsage`, and `linkOpening` writes succeed from any scope — personal or project — through `PATCH /account/api/preferences`, fenced by the same account revision as every other field. The selector rows stop rendering the blocked-state notice in project scope. A Gateway and client must ship together: a new client talking to a pre-055 Gateway receives the narrowed field union and its mutations are rejected with `invalid-account-preference`; the deployment upgrades both in one release.

Every additional `ui-conversation` preference field now has a complete checklist: schema, wire union, whitelist, normalizer, column, view, parser, and transport fake — the seven-layer checklist the first lag produced.

## Verification

`gateway/tests/account-preferences.spec.ts` accepts a `transcriptView` write through the HTTP route and rejects a legacy mode value before the service runs. `gateway/tests/postgres.spec.ts` migrates a legacy `normal` transcript mode to `detailed` and writes a new field through the real column path. The connection spec decodes the new fields, applies their defaults to older responses, and rejects invalid enum values in both layers. The account-scope spec verifies that whitelisted fields route to the endpoint, unlisted keys still write through the Host scope, and account override marks surface in the merged `user` layer.

## Related

[Chat content width carries a separate persisted fill flag](../feature/2026-09-16-chat-full-width-preference.md) documents the same account-preference path for the field that exposed this failure pattern first.
