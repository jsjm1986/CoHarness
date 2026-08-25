# Agent Note: Unlimited default document uploads

Status: implemented

English | [中文](2026-08-22-unlimited-document-upload.zh.md)

## Problem

Document uploads used a default 100 MiB per-file admission limit even though stored documents are ordinary files consumed through the filesystem. A browser or tunnel disconnect was reported only as `Document upload failed.`, which did not distinguish a transport interruption from a server rejection.

## Decision

`UserDocLimits.maxFileBytes` is nullable. The local store defaults it to `null`, and the streaming writer plus HTTP `Content-Length` preflight enforce the check only when a deployment supplies a finite value. Message document count, aggregate message bytes, and inline-text bytes remain separate protections for prompt submission and model context. The document manager states that the default per-file size is unlimited.

Both browser document clients report a connection interruption when XHR fails with status `0`, while preserving structured HTTP errors and caller-triggered aborts. The message identifies the network or tunnel as the next diagnostic target without retrying automatically, because a lost response cannot prove whether the server published a file and an automatic retry could create a duplicate.

## Alternatives considered

**Use a large numeric sentinel for unlimited uploads.** Rejected because the sentinel would still be a real upper bound, would render as a misleading file size in the UI, and would make the wire contract depend on a magic number. `null` states the absence of a limit directly.

**Remove the configurable per-file limit entirely.** Rejected because deployments may need a local finite guard for filesystem or operational policy; the default is unlimited while an explicit configuration remains available.

**Retry a failed XHR automatically.** Rejected because a connection can fail after the server publishes the file but before the response reaches the browser; retrying without an idempotency key can create a suffixed duplicate. The client now exposes a diagnostic message so the user can choose whether to retry.

**Remove message-level limits along with the per-file limit.** Rejected because document count, aggregate message bytes, and inline text bytes protect prompt assembly and model context independently of storage admission.

## Consequences

The application no longer rejects a document solely because it exceeds the old 100 MiB default. A finite `maxFileBytes` still produces the existing `DOCUMENT_TOO_LARGE` response, and the filesystem, browser, gateway, tunnel, and hosting plan remain external transport or storage limits. Upload failures caused by a disconnected tunnel are actionable in the composer instead of collapsing into the generic failure text. The later [resumable upload decision](../architecture/2026-08-25-resumable-user-document-upload.md) now addresses external single-request limits; this note remains the authority for nullable admission and connection-diagnostic wording.
