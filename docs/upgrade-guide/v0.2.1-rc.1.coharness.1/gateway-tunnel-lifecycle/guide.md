---
kind: upgrade-guide
description: "Managed tunnel shutdown retains failed cleanup and named provisioning resumes from durable ids."
---

# Managed tunnels retain cleanup and provisioning state

English | [中文](guide.zh.md)

## Change

Tunnel children drain output and exclude Gateway deployment credentials. The selected connector token uses an explicit `TUNNEL_TOKEN` environment entry, so process arguments do not expose it. A failed local stop reports `502 tunnel-stop-unconfirmed` and keeps the handle; replacement and Clear wait for confirmed closure. Shutdown rejects new actions with `503 tunnel-shutting-down` and drains accepted work. Named provisioning canonicalizes DNS inputs, validates before destructive work and uses the zone's account. Creating a tunnel and retrieving its connector token are separate Cloudflare requests; acknowledged ids survive token or configuration failures.

Both modes await a private registration witness. Stop/Clear cancel earlier accepted starts, including queued requests, with `409 tunnel-start-cancelled`; shutdown cancels registration before draining HTTP writers. `HGW_TUNNEL_STARTUP_TIMEOUT_MS` defaults to 30000, `HGW_TUNNEL_CLOSE_TIMEOUT_MS` to 5000 and `HGW_TUNNEL_PROBE_INTERVAL_MS` to 25. Polling cannot exceed the startup deadline. Programmatic `spawnQuickTunnel` and `spawnNamedTunnel` take explicit launch options and return immediate ownership; await `proc.ready` before publishing availability and retain the handle until termination succeeds.

Cancellation also reaches discovery, version probes, installation and Cloudflare requests. Custom `resolveBinary` and `install` implementations receive an optional `AbortSignal` and must honor it while awaiting external work; `installCloudflared` accepts it as its third argument. Native helper commands confirm closure. Failed downloads release their streams and retain the installed binary; publication uses a validated executable staged on the destination filesystem. Administrative reads during shutdown report `503 tunnel-shutting-down`.

## Migration

1. Stop managed tunnels through the deployment page before replacing the Gateway payload. Keep the existing PostgreSQL tunnel row and `HGW_TUNNEL_CREDENTIAL_KEY_FILE`; this change needs no schema migration.
2. Supply workload settings through explicit runtime configuration; see [child inheritance](../../../../gateway/README.md#performance-and-runtime-admission). Ambient Gateway database and credential variables do not reach the connector.
3. Retry a failed stop before starting a replacement. Retry Start named after token or ingress failures to reuse the retained id. Clear removes retained named resources even when quick mode is selected.
4. If an older payload created a Cloudflare tunnel but lost its id, inspect the administrator's Cloudflare account before provisioning again. A lost external create response can require provider-side reconciliation. See the [lifecycle limitations](../../../../.agents/notes/implemented/bug-fix/2026-10-25-gateway-tunnel-lifecycle.md).
