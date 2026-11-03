---
kind: upgrade-guide
description: "Document catalog operations reject revoked authority and hide inaccessible Steward and archived-project metadata."
---

# Document catalog access requires current authority

English | [中文](guide.zh.md)

## Change

Document synchronization, trash, purge and ownership transfers reject authority revoked during database waits. Administrator lifecycle actions also reject a disabled or demoted administrator; batch HTTP responses retain their per-document failure results. Previously these transactions could commit using authority read before waiting.

Steward metadata, history and member mutations require both current administrator membership and enabled Steward qualification. User document overviews exclude inaccessible Steward documents and archived projects from rows, totals and metrics; administrator inspection retains organization-wide audit metadata. Previous member overviews could expose these entries.

Batch catalog removals lock their initial active rows before access-revision updates and preserve registrations committed while waiting. A concurrent lifecycle writer can complete alongside the batch; the previous lock order could return HTTP 503 after a database deadlock.

## Migration

1. Deploy the Gateway through the [deployment procedure](../../../../gateway/README.md). No schema or document-file migration is required.
2. Custom catalog clients must handle HTTP 403 as a permission denial and inspect each administrator batch result. Refresh current access before retrying. Database refusals roll back catalog changes and history; a filesystem action completed before its catalog callback can still require reconciliation.
3. Grant Steward qualification only to current administrators through the Steward administration page. Confirm qualified access succeeds and revoked or demoted accounts cannot read Steward metadata or modify its catalog. See the [document lifecycle decision](../../../../.agents/notes/implemented/architecture/2026-08-27-document-index-pagination-and-trash-lifecycle.md).
