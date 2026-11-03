# Agent Note: Shared project font controls retain account ownership

Status: implemented

English | [中文](2026-11-01-account-font-preferences.zh.md)

## Problem

The theme controls declare account-or-host storage, but the account field router and Gateway omit six font fields. A shared project’s read-only Host therefore disables the controls. Personal font values can remain in a legacy file even after the account’s earlier appearance migration.

## Decision

The account field router, browser JSON reader and Gateway accept the six existing theme font fields with the same integer ranges and string values as the controls. Reads and writes retain the authenticated account, organization eligibility and account-wide revision. Different computer contexts read that shared account row. Project Host write permissions retain their existing owner.

PostgreSQL migration103 adds six nullable override columns and an independent font-import timestamp. The first account transaction imports valid missing font values from the account’s own personal settings file. Existing appearance, explicit fonts and empty-string font lists are retained. Importing an override advances the revision; completing an empty import still records its timestamp. Storage failure commits neither imports nor the timestamp. The source file is retained.

Reset removes an override after import has completed. The timestamp prevents a later read from restoring that old file value. An existing row with every font explicit completes its import without reading an unnecessary legacy file. Browser availability and errors follow the selected account scope;404/501 preserve standalone Host fallback.

## Alternatives considered

**Write shared project Host settings.** A member’s personal font choice would require project write authority and affect other members.

**Import whenever a column is null.** Reset uses null to remove an override, so a later read would restore the legacy value. The import timestamp records completion independently of overrides.

**Replace the complete account theme from the old file.** Earlier account appearance and explicit new fonts must retain their current values.

## Consequences

Gateway and Web builds require matching font fields and migration103. Standalone Host persistence and theme normalization remain unchanged. This complements [account eligibility and migration retry](2026-10-29-account-preference-authority.md) and the [font presentation decision](../architecture/2026-10-17-configurable-font-settings.md).

## Verification

Browser scope tests retain a read-only project Host while all six controls set and reset through account JSON. Wire and mutation cases cover role-specific limits, invalid values and explicit empty fonts. Actual PostgreSQL transactions cover fresh and existing legacy imports, explicit values, reset retention, unreadable-file retry and different accounts. Authenticated Gateway processes replay the browser transport across two computer contexts, retain the original personal file, refuse actor-field redirection and reject a disabled account.
