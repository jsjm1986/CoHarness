# Agent Note: Same-version Runtime survivor retention across Gateway restart

Status: implemented

English | [中文](2026-11-11-runtime-survivor-retention.zh.md)

## Problem

`LocalLauncher.instancesOutliveGateway=false` meant every graceful Gateway shutdown drained every local Runtime (`stopAll` → `stop_reason='shutdown'`). On the active development Mac mini, each deploy forced every space through a ~13s cold start on next entry — the dominant source of "open the UI and wait". `systemd` nodes already keep Runtimes across restarts; the local launcher chose drain as policy, not technical necessity: owner records, credential hashes, principal keys, and supervisor kernel leases all survive a Gateway process restart.

## Decision

Retention becomes the default for the local launcher, gated by a **launch signature** instead of blindly trusting survivors.

- `boot-signature.ts` computes a `RuntimeBootSignature` — release root, dsh repo root, Node version/path, launcher kind, full `dshCommand`, SHA-256 of the resolved dsh entry script, the supervisor source, and the repo `git HEAD` — persisted atomically to `<stateRoot>/boot-signature.json` (mode 0600).
- Before serving requests, `index.ts` compares the recorded signature with the computed one. Equal → survivors stay adopted and reattach through the existing `attachSurvivor`/`liveEndpoint` path. Different or absent → `instances.drainSurvivors('shutdown')` terminates adopted and tracked targets through the normal `stop` pipeline before `server.listen`.
- `stopAll(retainLocalSurvivors)` keeps the historical drain as the default (129 test/cleanup call sites depend on it); production shutdown passes `!cfg.drainRuntimesOnShutdown`. `HGW_DRAIN_RUNTIMES_ON_SHUTDOWN=true` restores the old semantics for operators who want "shutdown means drain".
- `drainSurvivors` reuses one bounded-concurrency `drainTargets` helper shared with `stopAll`; per-target failures collect and the first rejects.

## Alternatives considered

**Marker file written by the deploy script.** A deploy opt-in flag cannot express upgrades that bypass the script; hashing the actual launch inputs (entry/supervisor content, release root) makes the compatibility decision self-verifying.

**Set `instancesOutliveGateway=true` for local.** Removes the drain on shutdown but drops the upgrade guard entirely: a new release would reattach old-code survivors indefinitely.

## Consequences

Same-version restarts cost zero cold starts: the Runtime row stays `ready`, its generation never bumps, and the supervisor+child keep their ports. Upgrades, launcher changes, or Node toolchain changes still drain conservatively. Adopted-but-stopped rows keep their existing fail-safe: the next-boot manager counts the lease as resident until termination is confirmed, and a legacy row without a credential hash still refuses reattachment rather than inventing authority.

One observed boot-time interaction: a drain holds per-target serialize and Postgres locks; concurrent passive `ensureRunning` calls can hit the node-resource admission timeout during that window. They self-heal on retry (observed: the admin personal Runtime went `starting` → `ready` on the same boot), but a drain under a live site produces a brief admission stall.

## Verification

- `boot-signature.spec.ts`: round-trip, malformed/missing → absent, entry-content change flips only `entrySha256`, release-root move changes the signature (3/3).
- `instances.spec.ts`: `drainSurvivors` reattaches and terminates adopted survivors across `unread`/`isLive`/`ensureRunning` reads; a real `FAKE_DSH` child keeps serving HTTP across `stopAll(true)`, stays `ready`, and the next-boot manager counts it resident (98/98 suite).
- `config.spec.ts`: default `drainRuntimesOnShutdown=false`, `true`/`false` accepted, other values rejected (45/45 with signature suite).
- Production mac-mini: r54→r55 boot drained all 5 legacy supervisors (signature absent → conservative) and wrote `boot-signature.json`; a subsequent same-release `launchctl kickstart -k` left supervisor `16635` + child `16637` (port 42000) alive, row `ready` gen 14088 unchanged, no drain log line.
