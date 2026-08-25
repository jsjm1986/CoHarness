# @deepseek-ai/dsh-host-userdoc-http

English | [中文](README.zh.md)

Streaming browser HTTP consumer for [`ctx.userDocs`](../../attachment/userdoc/README.md). It registers `/api/documents` through Host Connection, so the existing Host/Origin trust check runs before the route while upload bytes bypass Connection's buffered JSON bridge.

`GET /api/documents` returns deployment limits and the recursive document view; adding `?directory=<directoryId>` returns one folder's immediate children. `GET /api/documents/directories` returns move destinations. `POST`, `PATCH`, and `DELETE /api/documents/folders` create, rename, and delete empty folders, while `POST /api/documents/move` moves one document without replacing an occupied destination.

Uploads use the versioned resumable session protocol: `POST /api/documents/uploads` creates or reuses a session, `PUT /api/documents/uploads/<uploadId>/chunks/<index>` accepts one raw `Content-Range` chunk with its SHA-256, `POST /api/documents/uploads/<uploadId>/complete` starts final verification, `GET` reports progress, and `DELETE` cancels. Every chunk is smaller than the public ingress limit, so the route does not depend on one request carrying the whole file. The removed one-request `POST /api/documents` answers `426 UPLOAD_PROTOCOL_REQUIRED`. `GET` or `HEAD /api/documents/content?id=<docId>` streams a download with `nosniff` and attachment disposition. `DELETE /api/documents?id=<docId>` removes one document idempotently. Responses expose stable `UserDocError.code` values and never include document bytes or a failed absolute path.

`POST /api/documents/transfer` is the versioned Gateway-backed snapshot-copy operation. The body names any personal or project source and target plus document ids; project-to-project copies and administrator fan-out targets are supported. Project reads require membership, and project writes require `rw` membership (organization administrators have implicit `rw`). Gateway streams each source response directly into the target runtime upload, applies the target naming policy, returns per-file safe metadata, and records provenance in the metadata catalog and audit trail. Browser callers never receive source bytes or absolute paths. Standalone compositions without `gatewayRuntime` return `DOCUMENT_TRANSFER_UNAVAILABLE`.

`GET /api/documents/transfer/capabilities` returns the current safe scope labels and writable targets without listing or opening any document.

`POST /api/documents/transfer/list` accepts one authorized source scope and returns safe document metadata for the composer picker; it never returns paths or file bytes.

In the Gateway deployment, this browser route is admitted by the Gateway's document broker before the runtime proxy. Standalone compositions still use the Host consumer directly; neither path exposes a runtime loopback authority in a browser response.

`POST /api/documents/transfer/directories` lists safe target-folder metadata and `POST /api/documents/transfer/directories/create` creates a folder after a target `rw` check. `GET /api/documents/overview` returns metadata-only rows for every scope the actor can read, and `GET /api/documents/history` returns recent audited operations for the current scope.

`POST /api/documents/transfer/plan` performs a metadata-only preflight with a five-minute plan token. `/commit` and `/retry` revalidate source and target permissions before streaming; successful and failed files are committed independently.

## Model Experience

None, as this package only stores and transfers files; a separate session consumer decides what document content reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No authentication of its own** — the route inherits Connection's reachability and same-origin policy; deployments that expose the Web server beyond loopback must provide authentication at the gateway.
- **No server-side pagination** — recursive and immediate listings return their complete current result; the browser pages the returned documents locally.
- **Downloads are attachment-only** — inline previews require a separate viewer with format-specific content isolation.
- **Temporary upload sessions are bounded, not published documents** — session records expire according to the local provider policy; the published document remains until deleted.
