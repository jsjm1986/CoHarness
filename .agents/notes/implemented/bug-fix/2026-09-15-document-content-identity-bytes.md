# Agent Note: Document content serves identity bytes

Status: implemented

English | [中文](2026-09-15-document-content-identity-bytes.zh.md)

## Problem

Enabling `compression: gzip` on the web profile turned the runtime document download into a transformed response: the compression layer removes `content-length` while it rewrites the body, so the Gateway's cross-scope copy — which requires the declared size before streaming the source into the target upload — failed every document with "did not provide a stable document size". The browser saw "1 document failed to copy" and the add-to-conversation flow never completed.

## Decision

`/api/documents/content` is a byte-identity route: its response carries `cache-control: no-transform`, the RFC 7234 opt-out that the compression middleware honors, so `content-length` and the stored bytes reach every consumer unmodified. The Gateway's transfer broker additionally asks for `accept-encoding: identity` on the source fetch, keeping the copy correct even against a runtime whose response policy ignores `no-transform`.

## Alternatives considered

**Disable compression for the whole web profile.** Rejected: gzip on UI, JSON, and SSE-adjacent routes is the upgrade's intended gain; only the file-content route needs identity bytes, and `content-range` responses were already exempt.

**Buffer the source body and measure it.** Rejected: it defeats streaming to the target upload and duplicates a size the runtime already knows.

## Consequences

Cross-scope copy and add-to-conversation work under a gzip-enabled runtime, and browser downloads regain a declared length for progress display. Identity encoding costs nothing here — user documents are commonly already-compressed formats.

## Verification

`packages/host/userdoc-http/tests/loader-composition.spec.ts` boots the real WebServer with `compression: gzip` and asserts the content route answers `content-length` and no `content-encoding`. `gateway/tests/document-transfer.spec.ts` pins `accept-encoding: identity` on the source fetch.
