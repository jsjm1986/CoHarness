# Agent Note: Managed-node operations access and deployment verification

Status: implemented

English | [中文](2026-11-07-managed-node-ops-access-and-deploy-verification.zh.md)

## Problem

Hand-run node operations produced two recurring classes of confusion. First, deployed libraries drifted from source twice: once a node gateway answered `runtime-catalog/forbidden` on every forwarded request while every database authorization check passed — three compiled transitive dependencies (`server.js`, `node-service-proxy.js`, `principal.js`) were stale because only directly changed files had been copied; later an exact-id catalog resolution memo shipped source and green tests but the compiled `gateway/lib/` was never rebuilt, so all three nodes served an identical stale build. Second, interactive SSH to the Ubuntu node appeared to hang for minutes: its tunnel key carries `authorized_keys` options `restrict,pty,port-forwarding,permitopen="127.0.0.1:9",permitlisten="127.0.0.1:15432",permitlisten="127.0.0.1:18899",command="/bin/sleep 2147483647"`, so sshd ignores the requested command and runs the keepalive sleep. That restriction is deliberate hardening of the tunnel credential, not a connectivity fault.

## Decision

Two operating rules now stand for the macOS-anchored deployment (entry on mac-mini, remote nodes on Ubuntu and Windows).

- **Access keys are purpose-split.** The per-node tunnel key `~/.config/harness-gateway/<node>-db-tunnel/id_ed25519` exists only for the launchd-managed reverse tunnels; any interactive command through it authenticates and then blocks inside the forced `sleep`. Administration uses `~/.ssh/id_ed25519` for `ubuntu@101.36.115.219` and `~/.ssh/dsh-win-vps-test` for `administrator@47.108.174.138`. The tunnel-key restriction is a feature — fix access by choosing the right key, never by loosening `authorized_keys`.
- **A gateway code deployment is one ordered sequence, not a copy.** Run `npm run build` in `gateway/` first (specs exercise `src/` through tsx, so green tests never prove `lib/` freshness); rsync the whole `gateway/lib/` directory (`rsync -a --delete`) into every node's release lib — per-file copies let transitive compiled dependencies drift; then restart each gateway (`launchctl kickstart -k gui/<uid>/com.maycran.harness-gateway` on macOS, `sudo systemctl restart harness-gateway` on Ubuntu, `schtasks /run /tn HarnessNodeGateway` after `/end` on Windows); finally verify content, not identity — `grep -c <new symbol>` on the deployed file proves the change is present, while cross-node checksums prove only that every node is equally stale. Fresh `harness.compute_nodes` heartbeats and `status='active'` confirm process health afterwards.
- **Ubuntu runs two gateway lanes with different code layouts.** The default `harness-gateway.service` (port 8899) executes `node --import tsx/esm src/index.ts` inside `/srv/harness/gateway` — deployments there rsync `gateway/src/` plus `deploy/postgres/migrations/`, `lib/` is never read, and the workspace-era bare `@deepseek-ai/*` imports resolve through the `/srv/harness/node_modules/@deepseek-ai/` symlink farm into `/srv/harness/packages/**` (with `/srv/harness-deps/node_modules` holding registry dependencies). The multi-node lane is different: `harness-connected-gateway.service` (port 8999) and `harness-connected-agent.service` execute `node lib/index.js` / `node lib/node-agent-main.js` under `/srv/harness-node/current/gateway`, a symlink into `releases/coharness-full-real-<tag>` — that lane reads `lib/` and `deploy/` from the release tree, so it needs the same rsync payload as macOS/Windows, plus `systemctl restart harness-connected-gateway` after syncing so its migration ledger re-verifies. Syncing only `src/` leaves the connected lane on a stale `node-access-service.js` (observed: the old 4-argument `node_channel_lease` call survived a database that already required five, surfacing as `runtime-internal` 500 on the node-local service endpoint and `node-service/unavailable` upstream); diagnose each lane through its own `journalctl -u` unit.

## Verification

The end-to-end check is behavioral: after restart, issue two concurrent authenticated requests against the same environment through `https://harness.maycran.com/` and count matching `WITH actor AS MATERIALIZED` catalog statements in the PostgreSQL log — one statement proves the memoized resolver is live; two proves it is not. Statement capture itself has a trap: `ALTER DATABASE harness SET log_statement=none` overrides `ALTER SYSTEM` per session at connect time, so pooled connections must be churned (`pg_terminate_backend` on `application_name='dsh-gateway'` rows) after enabling `log_statement='all'`, then terminated again so quiet settings return. Restore the database-level override afterwards.

## Alternatives considered

**Ship only changed files.** Rejected — it produced the `forbidden` outage; compiled transitive dependencies move without touching their sources.

**Compare checksums across nodes.** Rejected — identical stale builds produce identical digests; only content checks and behavioral proof detect a missing change.

**Loosen the tunnel key to allow admin commands.** Rejected — tunnel credentials should stay incapable of shells even if their private key leaks; a separate admin key is the correct split.

## Consequences

The exact-id catalog memo is now provably deployed on all three nodes: two concurrent same-environment requests emit one catalog page query on the entry gateway and zero additional resolves on the remote node. Ubuntu administration works through the administrator key while tunnel sessions continue unaffected. The unrecorded risk that remains is drift of the administrator key list itself — if access fails again, inspect `authorized_keys` before assuming a network fault.
