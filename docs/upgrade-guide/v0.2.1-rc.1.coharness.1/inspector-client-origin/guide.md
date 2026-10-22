---
kind: upgrade-guide
description: "Inspector Client startup requires an admitted browser origin and bootstrap data containing clientOrigins."
---

# Inspector Client origin admission

English | [中文](guide.zh.md)

## Change

Inspector Client sources start only on loopback origins or exact origins listed in the Host's `clientOrigins`. Other pages retain the NodeJS Inspector bottom panel in **Host only** mode, without a Client `ctx.inspector`, source collector, or ingest reconnects. Local development through `localhost`, `127.0.0.1`, and IPv6 loopback retains Client inspection.

The injected `__DSH_INSPECTOR__` value and authenticated bootstrap response require a `clientOrigins` string array. Custom bootstrap producers must supply the same additional origins as the Worker. The [package reference](../../../../packages/experimental/inspector/README.md) describes origin admission and the explicit Host-only selector.

## Migration

1. Upgrade the Inspector Host, Client, and DevTools assets together, then reload existing browser pages. Custom bootstrap producers must include `clientOrigins: []`, or the exact list configured on the Host.
2. For a trusted local development hostname, retain its exact origin in the Host's `clientOrigins`. The browser must still reach this Host's loopback Worker endpoint; the allowlist does not provide a remote relay for Client ingest.
3. Open the bottom panel. An unsupported origin shows **NodeJS Inspector · Host only**, with no Client ingest attempts. An admitted origin includes its own Client alongside Host; the Host-only view excludes other connected Clients.
