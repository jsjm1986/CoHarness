# Agent Note: Admin-managed public access tunnel on Cloudflare Tunnel

Status: implemented

English | [中文](2026-10-18-admin-managed-public-access-tunnel.zh.md)

## Problem

Exposing a gateway for a team previously required hand-running `cloudflared login`, `cloudflared tunnel create`, DNS record edits, an ingress YAML, and a launchd/systemd unit — a path the deployment docs listed but no admin could complete from the console. New admins routinely did not know the option existed; the gateway had no public-access surface of its own.

## Decision

The gateway owns a managed tunnel lifecycle on the deployment page. `harness.tunnel_access` holds one row per `(organization_id, node_id)` with mode (`off`/`quick`/`named`), desired and observed state, the public URL, hostname plus the resolved zone domain, zone/account/tunnel ids, two AES-256-GCM ciphertext columns (`api_token_cipher`, `run_token_cipher`) keyed by a dedicated owner-only file `HGW_TUNNEL_CREDENTIAL_KEY_FILE`, the last error, and a monotonic revision. [tunnel-access.ts](../../../../gateway/src/tunnel-access.ts) serializes every start/stop/clear through one promise queue so admin clicks, restart resume, and unexpected child exits never interleave; [tunnel-supervisor.ts](../../../../gateway/src/tunnel-supervisor.ts) resolves the `cloudflared` binary (env override → managed state dir → PATH/well-known paths), downloads the pinned release with per-platform SHA-256 verification when absent, and tracks each child through `spawn`'s close event; [cloudflare-api.ts](../../../../gateway/src/cloudflare-api.ts) is a narrow REST client for the account/zone/tunnel/ingress/DNS calls named mode needs; [tunnel-access-service.ts](../../../../gateway/src/postgres/tunnel-access-service.ts) is the persistence and cipher seam.

Three admin routes — `GET /admin/api/tunnel`, `POST /admin/api/tunnel/install`, `POST /admin/api/tunnel/actions` — expose view, binary install, `start-quick`, `start-named`, `stop`, and `clear`, each audited as `admin.tunnel.*`. Quick mode spawns `cloudflared tunnel --url <loopback gateway>` and scrapes the ephemeral `*.trycloudflare.com` URL from stderr. Named mode asks for a Cloudflare API token once, resolves the account and zone, creates the tunnel, installs the token-scoped credentials, publishes `hostname → <tunnel>.cfargotunnel.com` DNS, and spawns `cloudflared tunnel run --token`; later starts reuse the stored run token so the API token can be discarded. Re-entering a different hostname first deletes the orphaned Cloudflare tunnel and DNS record before re-provisioning. Hostnames must end under the declared zone domain; the tunnel only ever targets the gateway's own loopback listener. Desired state persists across gateway restarts via `resume()` after listeners bind and `shutdown()` stops the child; the credential key file joins systemd's inaccessible paths so runtime instances cannot read it.

## Alternatives considered

**Document-only guidance.** The deployment docs already named Cloudflare Tunnel as an ingress option; nothing changed for admins who never learned the manual recipe. Rejected because the feature request was precisely to remove the manual path for new admins.

**A self-operated shared domain (e.g. `*.coharness.dev`).** Would have given true one-click fixed hostnames, but it makes the project an edge operator — hosting cost, abuse handling, and availability responsibility — for a convenience gain. Rejected; named mode with the user's own Cloudflare zone delivers fixed hostnames without that role.

**Quick tunnels only.** Zero-account setup, but the URL changes on every start and cannot be fixed, which fails the "give the team a stable address" requirement. Kept as the zero-configuration path alongside named mode rather than alone.

**ngrok or another tunnel vendor.** A second vendor would double the supervisor, API client, and tests for the same capability; Cloudflare already covers both ephemeral and persistent modes, so single-vendor scope won.

## Consequences

- Enabling a tunnel deliberately exposes the gateway login surface to the public internet; the UI states this at the point of action and every action lands in the audit log.
- Quick-mode URLs are ephemeral by Cloudflare design — each restart mints a new `*.trycloudflare.com` name; the UI shows the current URL rather than pretending stability.
- Named mode persists a Cloudflare API token and tunnel run token encrypted at rest with an owner-only key; operators who prefer to drop the API token after setup may, since restarts and resumes only need the run token.
- The gateway now supervises a long-lived public-ingress child; its lifecycle is pinned to the gateway's (shutdown stops it), and a missing binary degrades to a 503 `tunnel-unavailable`/`cloudflared-not-installed` surface rather than a crash.
- Admin clicks during an in-flight operation queue behind it — deterministic, at the cost of slower UI feedback on contention.

## Verification

`gateway/tests/tunnel-access.spec.ts` covers view defaults, missing-binary 503, quick start URL capture, spawn failure to error state, unexpected child exit while desired, stop clearing intent and URL, first-time named provisioning (account/zone/tunnel/ingress/DNS calls plus ciphertext persistence), stored-credential named restart with zero API calls, missing-token and wrong-domain 400s, clear deleting DNS + tunnel records, restart resume, and managed install delegation — 13 tests over an in-memory store with injected process and fetch seams. `TunnelAccessSection.spec.tsx` covers install-offer, quick start, named-form gating, and running-state stop; `dictionaries.spec.ts` gates the new bilingual copy. `tsc -p tsconfig.ci.json` and the admin-ui production build pass.
