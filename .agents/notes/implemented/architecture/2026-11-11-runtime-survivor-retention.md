# Agent Note: Runtime survivor retention with launch stamps

Status: implemented

English | [中文](2026-11-11-runtime-survivor-retention.zh.md)

## Problem

`LocalLauncher.instancesOutliveGateway=false` meant every graceful Gateway shutdown drained every local Runtime (`stopAll` → `stop_reason='shutdown'`). On the active development Mac mini, each deploy forced every space through a ~13s cold start on next entry — the dominant source of "open the UI and wait". `systemd` nodes already keep Runtimes across restarts; the local launcher chose drain as policy, not technical necessity: owner records, credential hashes, principal keys, and supervisor kernel leases all survive a Gateway process restart.

## Decision

Retention becomes the default for the local launcher, gated by a per-generation **launch stamp** instead of a global signature file.

- `launch-stamp.ts` computes `computeLaunchStamps(cfg, principalPublicKey, profile)`: a content digest over the Runtime code closure (`apps`, `packages`, `vendor`, `plugins` under `dshRepoRoot`, plus lockfiles), the resolved supervisor source, the normalized `dshCommand` (node binary as `process.version`, the `argv[1]` entry script as a content digest, later arguments as literal text — runtime-created files never enter the signature), launcher kind, node exec path/version, profile, credential format (`principalPublicKey`, `streamPrincipalRenewal`), the default-env file, and every materialized policy package (governance, guard, steward tools, desktop driver). The base digest is combined per **launch variant** (`admin` × `kind` × `steward`) with the exact `policyPatchText` that `mountPolicyBundles` writes, so a row's stamp records everything its generation was booted with.
- `beginStart` mints the stamp for the descriptor's variant and persists it as `instances.launch_stamp` (SQLite schema 10, Postgres migration 129) atomically with the generation claim. A variant whose policy inputs are missing cannot be minted: `stampFor` throws the same configuration error the mount would have produced, before a generation is consumed; the failed attempt still publishes quiescence for the existing generation so queued resource work wakes. When no variant at all can be minted, stamp computation itself fails — `retireIncompatibleSurvivors` then retires nothing and request-time fences surface the misconfiguration instead of killing healthy processes.
- Before serving requests, `index.ts` calls `instances.retireIncompatibleSurvivors()`: adopted survivors whose recorded stamp is not a member of the minted set — including `NULL` legacy rows — are stopped under `shutdown` through the normal `stop` pipeline. Rows whose stamp matches stay adopted and reattach through `attachSurvivor`/`liveEndpoint`.
- The same fence runs lazily: `liveEndpoint` returns `null` for a ready row with an unminted stamp; `ensureRunningNow` terminates the observed generation under `shutdown` before falling through to a fresh start; the reconcile probe retires stamped-incompatible ready rows under `shutdown`, generation-fenced like the dead-probe path. A survivor that could not be stopped stays fenced rather than re-attached.
- `stopAll(retainLocalSurvivors)` keeps the historical drain as the default (test cleanup call sites depend on it); production shutdown passes `!cfg.drainRuntimesOnShutdown`. `HGW_DRAIN_RUNTIMES_ON_SHUTDOWN=true` restores the old semantics for operators who want "shutdown means drain".
- The earlier global `boot-signature.json` mechanism (same goal, coarser inputs: release path, entry file hash, git HEAD) was replaced because it could not see in-place rebuilds and still drained on every content-identical release-directory move.

## Alternatives considered

**Marker file written by the deploy script.** A deploy opt-in flag cannot express upgrades that bypass the script; hashing the actual launch inputs makes the compatibility decision self-verifying.

**Set `instancesOutliveGateway=true` for local.** Removes the drain on shutdown but drops the upgrade guard entirely: a new release would reattach old-code survivors indefinitely.

**Keep the global boot signature.** It hashed only the gateway's own thin entry and supervisor files, so runtime-code changes under an identical path went undetected (in-place rebuild), while a byte-identical release under a new path drained everything anyway. Per-row content stamps make both directions correct.

## Consequences

Same-content restarts and gateway-only releases cost zero cold starts: the Runtime row stays `ready`, its generation never bumps, and the supervisor+child keep their ports. Runtime-code, launch-input, credential-format, or toolchain changes retire conservatively and the row's next entry cold-starts. Adopted-but-stopped rows keep their existing fail-safe: the next-boot manager counts the lease as resident until termination is confirmed, and a legacy row without a credential hash still refuses reattachment rather than inventing authority.

A stamp mismatch caused by a mid-lifetime config change (for example rotating the default env file) retires survivors exactly like a code change — deliberate, since those inputs are part of what the generation booted with. Role transitions (member→admin) keep a survivor attached under its recorded variant until the next generation; use-time policy checks still apply per request.

Old release directories must not be deleted while survivors still run from them: the survivor's code closure is loaded lazily, so removing the tree breaks a retained process even though its row passes the fence.

## Verification

- `launch-stamp.spec.ts`: deterministic minting, per-variant stamps differ, closure-content change flips every stamp, identical content at a moved path mints the same set, missing governance package fails the whole set, and `policyPatchText` embeds admin/steward overlays only for their variants (6/6).
- `instances.spec.ts`: incompatible-stamp survivors are retired under `shutdown` by `retireIncompatibleSurvivors`, by `ensureRunning`, and by the reconcile probe; a minted-stamp survivor stays adopted and re-attaches; a real `FAKE_DSH` start records the member stamp in `instances.launch_stamp` (109/109 suite).
- Production mac-mini: r54→r55 boot drained all 5 legacy supervisors and a same-release `launchctl kickstart -k` left supervisor `16635` + child `16637` (port 42000) alive with the row `ready` generation unchanged; an authenticated proxy request after a restart returned in 33ms.
