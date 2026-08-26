# Agent Note: Gateway-owned document scope listing

Status: implemented

English | [中文](2026-08-25-gateway-document-scope-loopback-leak.zh.md)

## Problem

The document manager's alternate-scope listing used the public `/api` proxy path. That path can reach a runtime HTTP server whose authority is a per-instance loopback port, so an upstream redirect or an incomplete runtime could turn a browser operation into navigation toward `127.0.0.1:<port>`. Runtime ports and private runtime failures are host facts and must not be part of a browser response.

## Decision

Gateway owns `POST /api/documents/transfer/list` whenever the PostgreSQL document broker is configured. The route parses the bounded JSON body, delegates authorization and metadata retrieval to the same broker used by runtime consumers, returns a no-store JSON response, and maps broker failures to stable nested error objects. The broker refuses internal redirects while reading the selected runtime. The generic proxy also rewrites loopback `Location` headers to same-origin paths as a defense in depth for other upstream routes.

## Alternatives considered

**Keep the list request on the generic runtime proxy.** Rejected because the proxy has no document-specific response contract and can forward an internal runtime authority or HTML navigation response.

**Expose a browser-safe runtime URL and rely on client filtering.** Rejected because a browser-visible runtime authority is an unnecessary capability and client code cannot prevent navigation or protect other clients.

**Duplicate authorization in the Gateway route.** Rejected because it would drift from the established document broker. The public adapter supplies the authenticated `UserRow` to the same actor-level broker used by the runtime adapter.

## Consequences

Scope switching remains an in-page JSON operation even when the selected runtime is starting, unavailable, or returns a redirect. Runtime loopback addresses remain confined to Gateway-to-runtime requests. Other proxied redirects cannot disclose a loopback authority, while non-loopback redirects retain their upstream semantics.

## Testing

`gateway/tests/server.spec.ts` verifies the public list route is handled without the proxy and has no `Location` header. `gateway/tests/document-transfer.spec.ts` verifies the public adapter shares project authorization and rejects internal redirects. `gateway/tests/proxy.spec.ts` verifies loopback redirect rewriting and preserves a non-loopback-looking hostname.

## Related

- [Document scope runtime readiness and safe provider projections](2026-08-26-document-scope-runtime-readiness.md) — owns transient runtime retries, structured readiness errors, and canonical Provider URL projection.
