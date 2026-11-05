---
kind: upgrade-guide
description: Admin JSON reads require current account eligibility before their data and metadata headers are published.
---
# Current administrator qualification for JSON reads

English | [中文](guide.zh.md)

## Change

The Admin JSON responder checks current administrator eligibility after asynchronous data preparation, including organization, membership, account, role and required password changes. A withdrawn reader receives403 without selected data, audit totals or archive attachment names. An unavailable account lookup returns503 with `admin-authorization-unavailable`. GET and HEAD reads, plus explicitly selected POST diagnostics such as backup configuration preview, use this qualification. A preparatory verification may already have committed when its later preview is refused. Ordinary admitted mutations retain their owning service's result.

## Migration

1. Custom account adapters must make `getById()` return current effective eligibility, including organization and membership status, and null for deleted or missing accounts. A cached HTTP identity is insufficient.
2. Custom Runtime-management assembly supplies the request-owned `AdministratorResponse`; the standard Admin router does this automatically. Await its publication before completing the handler. Diagnostics transported by POST select `readJson()` explicitly.
3. Clients handle403 as loss of current administrator access and503 as unavailable authorization. No database migration is required. See the [publication decision](../../../../.agents/notes/implemented/bug-fix/2026-11-05-administrator-read-publication.md).
