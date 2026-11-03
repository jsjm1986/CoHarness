---
kind: upgrade-guide
description: "Audit result filters, counts and selected pages remain consistent across storage and reordered requests."
---

# Keep audit filters and selected pages consistent

English | [中文](guide.zh.md)

## Change

SQLite outcome filters and counts follow the result displayed on each row. HTTP status takes precedence over the action name; without a status, only an exact, case-sensitive failure suffix classifies the row as failed. PostgreSQL writers use the same classifier. Raw details remain excluded from the Admin response.

`GET /admin/api/audit` requires safe integers for `limit` and `offset`. Fractions and unsafe values return400 with `error: invalid audit pagination` before database access. Supported integer values retain clamping: page sizes range from1 to500 and negative offsets become0.

The Audit page only applies results, errors and completion from its latest query. Older responses cannot replace a newly selected family, filter or page, or hide its loading indicator. Narrow layouts wrap the audit family controls within the page; all families remain reachable.

## Migration

1. Deploy Gateway and rebuild the Admin UI using the [existing procedure](../../../../gateway/README.md). These fixes require no additional schema or Session-format migration.
2. API clients and custom audit services supply integer pagination counts. Keep handling HTTP400 for invalid filters. Page totals count the same outcome predicate as the returned rows.
3. Verify HTTP success with a failure-named action stays in the success filter, status-less failure events remain discoverable, and an older query cannot replace a newer selected page. Read the [audit decision](../../../../.agents/notes/implemented/bug-fix/2026-10-10-audit-log-crash-and-faceted-query.md) for result precedence and metadata restrictions.
