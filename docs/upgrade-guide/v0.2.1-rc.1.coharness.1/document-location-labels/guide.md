---
kind: upgrade-guide
description: Document location consumers resolve published project names from the owning computer instead of governance aliases.
---

# Computer-owned document location names

English | [中文](guide.zh.md)

## Change

`GET /account/api/document-locations` marks published project locations with `metadataOnNode: true`. Their `name` is a public identifier such as `#41`, not the project name. The project name remains on its owning computer. Legacy locations continue returning their names directly.

The Web document manager resolves names independently through `GET /account/api/project-metadata?dshNode=<node>&ids=<project-ids>` in batches of at most 32. A slow computer retains its identifier without blocking other locations. A denied document listing clears the affected view and locks writes until current location permissions are confirmed; transient failures retain the previous rows.

## Migration

1. Deploy the matching Gateway and Web client. Custom location consumers must keep `scope.nodeId` and the project ID fixed while resolving display names; do not treat `#41` as a business name or save project names to the governance database.
2. Keep project-metadata reads account-authenticated and node-addressed. Do not start a Runtime to obtain labels or replace an unavailable computer with the local one.
3. Verify mobile upload choices after location pagination, project names on two computers, and denied-scope controls. No configuration or stored-data migration is required. See the [document manager](../../../../packages/client/ui-documents/README.md).
