# Agent Note: Atomic macOS Gateway release lifecycle

Status: implemented

English | [中文](2026-08-18-atomic-macos-gateway-releases.zh.md)

## Problem

A launchd job can retain an old release as its cwd while `current` is changed to a new directory. When the Gateway command, runtime command, and policy-plugin paths each contain `current`, later child starts can resolve a different release from the still-running parent. Removing the old directory then turns an ordinary upgrade into a mixed-version process tree with no reliable rollback target. Process liveness and a basic `{"ok":true}` health response do not detect this state.

## Decision

Forward-only database migrations can leave an earlier release unable to start. The controller reads the live governance ledger before selecting a candidate, using its own effective launch configuration and packaged migration files. The applied ledger must match a checksummed prefix of the candidate. A dedicated node content volume has its own checksummed ledger and must already match its packaged sequence.

The macOS deployment installs `gateway/deploy/macos/release-control.sh` in a stable control directory outside every release. launchd runs that stable copy with the releases root as its working directory. The controller resolves `current` once at Gateway start, exports the canonical target as `HGW_RELEASE_ROOT`, removes independently configured Gateway, CLI, repository, and policy-plugin paths, and starts the compiled Gateway entry from that same target. The production build creates the relative `gateway/node_modules/@deepseek-ai/*` links required by the standalone Gateway package — one per workspace package in `GATEWAY_RUNTIME_PACKAGES` in `scripts/build-production.ts` — and activation validates each emitted payload file and every runtime link before switching `current`. The launchd `run` path accepts an already-current source-only legacy release for implicit recovery; explicitly selected activation and recovery targets require compiled payloads.

When `HGW_RELEASE_ROOT` is present, Gateway configuration verifies that the running Gateway directory belongs to that release, derives the built CLI command and release-owned plugin paths from it, and rejects conflicting overrides. `/healthz` reports the immutable directory name as `release` without exposing its absolute host path.

Native payload validation requires the compiled JavaScript entries for both `landlock-run` and `flock` alongside the host binary. A link to the [native entry package](../../../../native/system/packages/entry/package.json) can resolve while its exported files are absent. Gateway health does not establish that a Runtime can import Session persistence or the sandbox; release verification includes starting the assembled Runtime and creating a Session through its real API.

Release activation requires the registered Gateway job and release Runtime processes to be stopped before changing `current`. Operators establish a maintenance window and pause automatic launch; the controller never signals a Gateway or its descendants. It validates the payload, holds the activation lock, replaces `current`, enables and starts the job without forced restart, then verifies PID, cwd and release identity. A live or unobservable failed candidate remains selected; automatic rollback requires confirmed process exit. This protects long tasks and schedules that an idle browser cannot reveal.

An explicit recovery target is fixed before process operations and must resolve to a complete compiled release directly under the releases root. The mutable `current` name is rejected before canonical resolution along with aliases that resolve to the candidate. After the failed candidate exits, the controller pauses automatic launch, resolves the fallback's own applied configuration, and compares it with the candidate's database and node coordinates. Rollback requires an exact match between the then-current governance and configured content ledgers and the fallback's files. Verification uses read-only transactions and the migration runners' advisory locks. It confirms process shutdown again immediately before changing `current`. A rejected or unverifiable fallback leaves the candidate selected and automatic launch paused for forward repair. A selected fallback must still prove PID, cwd and release-aware health.

Activation never removes releases. The explicit prune operation rejects `current`, the live Gateway cwd, a directory named in another process command, and a directory with open files. Operators retain at least the previous verified release until a later explicit prune.

The production build re-emits referenced package JavaScript before bundling so it matches the current source and declarations. The release manifest requires the governance and node-content migration additions used by this Gateway.

## Verification

Gateway configuration tests cover canonical release derivation and conflicting-path rejection. Server tests cover release-aware health responses. [macOS controller tests](../../../../gateway/tests/macos-release-control.spec.ts) cover literal process and release selection, refusal before mutation, and safe pruning. In the PostgreSQL fixture, a candidate process commits a forward migration and exits. The compatible fallback process uses the production migration runner and answers health from its selected directory. An earlier fallback is refused before it starts, including through direct activation. Both paths preserve the committed ledger and data.

## Alternatives considered

**Keep `current` in the plist and require a manual restart.** This leaves correctness dependent on operator ordering and permits launchd to keep a healthy-looking parent alive across a symlink change.

**Pin only the child runtime command.** This prevents one mixed CLI path but still lets the Gateway source, policy plugins, and future release-owned inputs resolve independently.

**Always restore the last running release.** Process history does not prove compatibility after a forward database migration. Explicit recovery selection permits restoration to software verified against the current database only after the candidate has stopped.

**Delete older releases automatically after activation.** Automatic cleanup reduces disk use but couples a destructive operation to the highest-risk part of deployment. A separate guarded prune keeps rollback available and makes deletion require current process evidence.

**Kill descendants to guarantee a clean restart.** A retained Runtime can own a long task, schedule or plugin service. Process-tree cleanup cannot establish a safe application checkpoint; missing or unhealthy Gateway state is not permission to terminate those children.

## Consequences

The macOS production layout needs one stable controller copy and one owner-controlled environment file in addition to release directories. Activation fails closed when payloads, launchd state, cwd, database readiness, or release identity disagree. Disk cleanup becomes an explicit step, so operators trade small temporary storage growth for deterministic rollback and the guarantee that a live process never loses its release directory through the supported workflow.
