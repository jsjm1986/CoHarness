# Agent Note: Combo route carries a static-extension filename for CDN edge caching

Status: implemented

English | [中文](2026-10-20-combo-route-static-extension.zh.md)

## Problem

The plugin bundle route was `/plugins/??<resources>&rev=<rev>` — the `??` opened the query string, so the path had no filename and no extension. CDNs such as Cloudflare select default cacheable responses by path extension, so every page load fetched the multi-megabyte immutable combo through the origin tunnel even though the response advertised `public, max-age=31536000, immutable`. Chunk URLs under `/plugins/<package>/<file>.js` already carried an extension and were edge-cached.

## Decision

The combo path carries a synthetic `combo.js` filename: `/plugins/combo.js??<resources>&rev=<rev>`. The filename exists for CDN static-extension rules; it names no file, and the map variant shares it so the script's relative `sourceMappingURL` trailer still resolves onto the same absolute key. Server-side lookup keys on `pathname + search`, so routing, revision enforcement, and partitioning are unchanged. The client-side `chunkUrl` resolver strips the synthetic segment — sibling chunks keep living under `/plugins/<package>/`.

## Alternatives considered

**A CDN cache rule for `/plugins/*`.** Rejected: it lives outside the repository, must be repeated per deployment and per provider, and silently regresses when the zone configuration drifts.

**Cache-key rewrites or a Worker.** Rejected: Enterprise-tier machinery to compensate for a path name the origin chooses itself.

## Consequences

First loads still pay the origin path; repeat loads and every visitor on the same edge receive the combo from cache. Edge-cached responses are served without re-running the origin session gate — the same posture `/assets/*` build artifacts already held; the payload stays an immutable, non-personalized bundle keyed by content revision. Requests for unknown resource lists or stale revisions still return origin 404s.
