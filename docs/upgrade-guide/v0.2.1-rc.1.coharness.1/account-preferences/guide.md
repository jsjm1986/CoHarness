---
kind: upgrade-guide
description: "Account preferences retain eligibility, import legacy fonts once, and preserve retryable storage failures."
---

# Upgrade account preference authorization and migration

English | [中文](guide.zh.md)

## Change

`GET` and `PATCH /account/api/preferences` retain current active organization, account and membership eligibility through their database transaction. A request that loses eligibility before admission returns403 without initializing or changing preferences. Accepted writes finish before a conflicting withdrawal commits. Account data remains available without a computer execution grant.

An unreadable legacy `settings.yaml` returns503 with `account-preferences-unavailable`, preserves its cause in server logs and leaves initialization uncommitted. After storage repair, a new request imports the actual legacy values. Missing files and malformed YAML still initialize defaults. Browser actor fields cannot redirect preferences to another account.

The account endpoint accepts `fontSize` (10–22), `codeFontSize` (10–16), `terminalFontSize` (10–20), and `textFontFamily`, `codeFontFamily`, `terminalFontFamily` under `ui-theme`. Gateway font controls remain writable in a shared project through this account endpoint. Project Host settings retain their existing write permissions. The first account read imports valid absent fonts from that account’s personal `settings.yaml`, preserving explicit account appearance and font values. A separate marker makes the import one-time, including after reset; read failures remain retryable, and the old file is retained. See the [font ownership decision](../../../../.agents/notes/implemented/bug-fix/2026-11-01-account-font-preferences.md).

## Migration

1. Apply PostgreSQL migration103 and upgrade the matching Gateway and Web client builds. Effective theme responses include all six font fields; overrides omit unset fields. Custom transports and preference services implement these fields and retain the existing revision fence.
2. Custom account preference services retain current eligibility and account identity through initialization, describe and mutate; cached request roles or status are insufficient.
3. On403, restore account eligibility and authenticate again. On503, repair the legacy settings path reported in server logs and retry; verify that the intended values and revision return. See the [account preference decision](../../../../.agents/notes/implemented/bug-fix/2026-10-29-account-preference-authority.md).
