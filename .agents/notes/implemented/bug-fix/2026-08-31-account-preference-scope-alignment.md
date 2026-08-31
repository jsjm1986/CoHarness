# Agent Note: Align account-owned conversation preference fields

Status: implemented

English | [中文](2026-08-31-account-preference-scope-alignment.zh.md)

## Problem

The browser conversation plugin binds busy-Enter, transcript width, and transcript font size to one account-or-host scope. The Gateway account endpoint accepted only busy-Enter for the `ui-conversation` namespace, so display writes were rejected as invalid account fields. Because the rows shared one scope, a rejected display write also surfaced as a save error beside the Enter control.

## Decision

The Gateway account preference contract stores all three `ui-conversation` fields. Migration `023_user_conversation_display_preferences.sql` adds nullable, range-constrained columns for width and font size; NULL retains the product defaults. The account service returns effective defaults, tracks explicit overrides, and fences every field with the existing account revision. Browser transport parsing and mutation preserve numeric values, while the Gateway validates the supported ranges before selecting a SQL column. Legacy settings files may seed valid display values when an account row is first created.

## Alternatives considered

**Bind display controls to a Host scope.** Rejected because a shared project runtime would make account display choices read-only or shared between project members, and would split one account-owned namespace across incompatible authorities.

**Keep display choices process-local.** Rejected because reloads, ports, and authenticated project runtimes would lose the user's selected reading settings.

**Store an untyped JSON bag in the account table.** Rejected because scalar columns retain database constraints, predictable updates, and the existing redacted account response without introducing another document format.

## Consequences

Existing account rows continue to use 748px and 14px until a user selects another value; the migration does not touch conversation events or reset locale, theme, or Enter choices. A display write no longer changes the Enter row's write state, and the same revision still serializes rapid edits across all account fields. Standalone Hosts continue to persist the namespace through their settings document. The account preference and PostgreSQL integration tests cover numeric validation, revisioned writes, defaults, and the additive migration.
