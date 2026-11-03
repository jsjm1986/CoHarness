---
description: "Streaming browser HTTP consumer for user-uploaded documents"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-userdoc-http

English | [中文](README.zh.md)

Streaming browser HTTP consumer for [`ctx.userDocs`](../../attachment/userdoc/README.md). It registers `/api/documents` through Host Connection, so the existing Host/Origin trust check runs before the route while upload bytes bypass Connection's buffered JSON bridge.

`GET /api/documents` returns deployment limits and the recursive document view; adding `?directory=<directoryId>` returns one folder's immediate children. Supplying `limit`, `cursor`, `q`, `type`, or `sort` requests a bounded metadata page with an opaque continuation cursor. `GET /api/documents/directories` returns move destinations. `POST`, `PATCH`, and `DELETE /api/documents/folders` create, rename, and delete empty folders, while `POST /api/documents/move` moves one document without replacing an occupied destination. `/api/documents/trash` lists or trashes documents, `/api/documents/restore` recovers one, and `DELETE /api/documents/purge` permanently removes one; all browser-facing references replace host paths with empty path fields.

Uploads use the versioned resumable session protocol: `POST /api/documents/uploads` creates or reuses a session, `PUT /api/documents/uploads/<uploadId>/chunks/<index>` accepts one raw `Content-Range` chunk with its SHA-256, `POST /api/documents/uploads/<uploadId>/complete` starts final verification, `GET` reports progress, and `DELETE` cancels. Every chunk is smaller than the public ingress limit, so the route does not depend on one request carrying the whole file. The removed one-request `POST /api/documents` answers `426 UPLOAD_PROTOCOL_REQUIRED`. `GET` or `HEAD /api/documents/content?id=<docId>` streams a download with `nosniff` and attachment disposition. `DELETE /api/documents?id=<docId>` moves one document to recoverable trash idempotently; `DELETE /api/documents/purge?id=<docId>` permanently removes a trashed document. Responses expose stable `UserDocError.code` values and never include document bytes or a failed absolute path.

Identity-aware scopes authorize exact publication revisions for every mutation, including administrator actions and complete folder inventories. Restore and purge select a unique `trashId`; an ambiguous path requires an explicit selection. Path-only standalone providers retain `409 DOCUMENT_TRASH_CONFLICT` when a retained entry shares an active path. Idempotence never proves deletion of a replacement.

`POST /api/documents/transfer` is the versioned Gateway-backed snapshot-copy operation. The body names any personal or project source and target plus document ids; project-to-project copies and administrator fan-out targets are supported. Project reads require membership, and project writes require `rw` membership (organization administrators have implicit `rw`). Gateway streams each source response directly into the target runtime upload, applies the target naming policy, returns per-file safe metadata, and records source identity in the metadata catalog and audit trail. Browser callers never receive source bytes or absolute paths. Runtime JSON metadata responses are read through an 8 MiB byte budget before validation, while active coalesced listings use waiter-local cancellation. Standalone compositions without `gatewayRuntime` return `DOCUMENT_TRANSFER_UNAVAILABLE`.

`GET /api/documents/transfer/capabilities` returns the current safe scope labels and writable targets without listing or opening any document.

`POST /api/documents/transfer/list` accepts one authorized source scope and returns safe document metadata for the composer picker; it never returns paths or file bytes. Transfer results and listings preserve validated optional document identity metadata; invalid supplied identities refuse the response, and unknown identity fields are omitted.

Chunk and content handlers cancel their store signal when the response closes, including closure during an earlier asynchronous lookup. Each upload operation captures its authenticated collaboration participant when that service is installed. A managed personal runtime without collaboration uses its verified Gateway request principal. A managed project requires collaboration authority; missing request identity or lost project authority returns `503 COLLABORATION_UNAVAILABLE` before a store operation. Standalone requests without either identity service remain ownerless. Browser fields cannot select an owner, project write membership does not grant access to another member’s temporary upload, and published documents follow their ordinary authorization policy.

The Gateway deployment also owns `/api/documents/transfer/uploads` and its resumable child routes. Each request names a personal or project target through a validated `scope` query, and the Gateway rechecks write authority before serving the session against the target scope's document root; it forwards to a target runtime only when no local document broker is configured. Standalone Host compositions continue to expose only the current-runtime upload route.

In the Gateway deployment the document broker serves the scope-facing routes itself: `handleUserDocHttp` is exported with the `UserDocHttpHost` adapter surface so the Gateway runs the same routes against an authorized scope's document root without a runtime process, and the `UserDocRequest`/`UserDocResponse` contract covers live sockets plus the broker's synthetic metadata calls. Standalone compositions still use the Host consumer directly; neither path exposes a runtime loopback authority in a browser response.

`POST /api/documents/transfer/directories` lists safe target-folder metadata and `POST /api/documents/transfer/directories/create` creates a folder after a target `rw` check. The `/api/documents/scope` subtree applies the same authorization to alternate-scope listing, content, folder, move, trash, restore, and purge requests, and the Gateway document broker answers them through this same handler. `GET /api/documents/overview` returns metadata-only rows for every scope the actor can read, and `GET /api/documents/history` returns recent audited operations for the current scope.

The Gateway's `document-admin` principal is accepted only by the trash, restore, and purge routes; ordinary document reads and writes still require the runtime user's scope authority.

`POST /api/documents/transfer/plan` performs a metadata-only preflight with a five-minute plan token. Browser copy previews request `HEAD` for the selected files, including nested files, without enumerating their folders. Content responses expose `Content-Length`, `Content-Type`, `Content-Disposition`, `Last-Modified` and the document identity header; `HEAD` sends no file body. `/commit` and `/retry` revalidate source and target permissions before streaming; successful and failed files are committed independently.

The Cordis plugin and Gateway broker each own a `UserDocHttpScope` that joins accepted handlers and deferred deliveries before releasing storage dependencies. Required lifecycle delivery failures reach the caller; standalone advisory synchronization still has no crash receipt. The managed Gateway provider persists authoritative identity changes in its private ordered journal and acknowledges only catalog-committed prefixes. Content responses carry `x-dsh-document-identity` as base64url JSON for the opened file, so delayed copy recording retains its exact source incarnation.

A scope's optional `admitCatalogWrite` callback runs when a delivery is queued and retains its writer while earlier deliveries finish. Refused admission skips that delivery while preserving the earlier queue and shutdown wait. Hosts must include immediate read-driven catalog writes in their own admission as well.

## Summary

Use `dsh-host-userdoc-http` as the streaming browser HTTP consumer for `ctx.userDocs`: it registers `/api/documents` through Host Connection so the Host/Origin trust check runs before the route while upload bytes bypass the buffered JSON bridge. The route family covers list, upload, move, trash, restore, purge, and folder operations with bounded pages and opaque cursors.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

None, as the streaming browser transport stores and retrieves files; a session consumer owns any model-visible rendering.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No authentication of its own** — the route inherits Connection's reachability and same-origin policy; deployments that expose the Web server beyond loopback must provide authentication at the gateway.
- **The legacy current-runtime listing is not indexed** — the provider may scan the root for a complete response; scoped Gateway listings use bounded pages for large workspaces.
- **Downloads default to attachment disposition** — the `inline=1` option is limited to images, PDFs, and text media and carries a restrictive content policy for the preview viewer.
- **Temporary upload sessions are bounded, not published documents** — session records expire according to the local provider policy; the published document remains until deleted.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
