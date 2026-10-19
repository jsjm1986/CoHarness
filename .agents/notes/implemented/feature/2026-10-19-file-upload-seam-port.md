# Agent Note: File-upload seam port

Status: implemented

English | [中文](2026-10-19-file-upload-seam-port.zh.md)

## Problem

Upstream `dsh-v0.2.1-rc.2` ships `packages/client/file-upload`: a transient Session-scoped upload surface (Host HTTP intake → content-addressed attachment → `agent:fileUploads/upload` receipt → prompt citation → `file` block). The fork had deferred it because `attachment/userdoc` + `host/userdoc-http` + `client/userdoc-upload` already cover durable resumable document upload — a different model — leaving the generic seam absent for consumers other than the composer.

## Decision

The seam is ported at [`packages/client/file-upload`](../../../../packages/client/file-upload/README.md) with two fork adaptations; the composer stays on the userdoc path.

- **HTTP transport**: upstream registers a Fetch handler through `connection.fetch.register`; the fork's host transport is `ctx.connection.http.handlePrefix` over Node `req`/`res`, so `http-route.ts` consumes the request stream and writes status, headers, and body through the Node API at the same `uploadFileBinary` prefix.
- **Cold-Session resolution**: upstream resolves the upload's Agent through a `registerAgentResolver` hook; the fork resolves through the optional `sessionController` service via `ctx.get('sessionController')` — absent means the session is not uploadable, matching how other remote surfaces cold-load Sessions.

The service keeps upstream semantics: uploads are one-shot, non-resumable receipts bound to one Session; admission into a prompt stays the commands layer's job. It does not replace userdoc — `userdoc` uploads are durable documents with SHA-256 chunked resume — and `ui-conversation`'s composer continues to route non-image picks through `createDraftDocuments`.

## Alternatives considered

- **Rewiring the composer to `ctx.fileUpload.upload`** was rejected: it would resurrect the duplicate pick path removed in favor of userdoc, giving users two visually identical but semantically different upload behaviors.
- **Leaving the seam unported** was rejected on API-parity grounds: `agent:fileUploads/upload` is part of the published client surface and consumers other than the composer — SDK callers and future plugins — may rely on it.

## Testing

`tests/file-upload.client.spec.ts` and `tests/file-upload-http.host.spec.ts` cover receipt staging, HTTP intake success and failure (oversized body, unknown session), and the generated Typert artifacts. `apps/web/tests/file-upload-round.e2e.ts` restores the upstream browser scenario against the fork's composer: it drives the document rail and image rail (upstream's single pending-attachments rail and staged-receipt send gate do not exist here), asserts the userdoc admission — rendered text plus `source.documents` and `userdoc/attached` instead of a `file` block — and reads the saved copy through the real `read` tool against `snapshots/web/file-upload-round/session.v7.jsonl`.

## Consequences

Two upload models coexist deliberately; callers must pick per use case. `cordis.patch.yml` mounts the package in the web composition and `scripts/upstream-sync.json` classifies it `adapted`. A future consumer needing transient receipts — automation, a plugin without durable storage — can use `ctx.fileUploads` without touching the composer.
