---
kind: upgrade-guide
description: "Archive and document management assertions reject HTTP operations outside their declared purpose."
---

# Restrict dedicated Gateway assertions to their declared operations

English | [中文](guide.zh.md)

## Change

`archive-read` assertions accept only `GET /api/internal/archive/read`. `document-admin` assertions accept only `POST /api/documents/trash`, `POST /api/documents/restore` and `DELETE /api/documents/purge`. Previously, runtime authentication admitted these assertions to unrelated HTTP endpoints, where individual handlers decided access. Requests outside the declared methods and paths now receive HTTP 401 before dispatch, even when the assertion names an administrator.

The Gateway's private runtime API rejects purpose-bound assertions with HTTP 403 unless the endpoint explicitly admits that purpose. Restricted assertions cannot invoke cross-scope transfer callbacks. The document lifecycle catalog endpoints retain their explicit `document-admin` allowance.

## Migration

1. Upgrade the Gateway and `dsh-gateway-runtime` together and restart managed runtimes. Existing Gateway archive readers and document lifecycle brokers already use the permitted routes.
2. Update custom callers that reuse these assertions for unrelated operations. Interactive requests require their own authenticated user assertion; keep dedicated assertions confined to the [documented operations](../../../../packages/context/gateway-runtime/README.md#runtime-contract).
3. Confirm archive export and administrator document recovery still work. Reuse either dedicated assertion for a document upload or Session operation and confirm HTTP 401 with no mutation. No document, database or Session-log migration is required.
