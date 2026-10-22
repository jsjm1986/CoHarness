# Agent Note: Atomic macOS Gateway release lifecycle

Status: implemented

English | [中文](2026-08-18-atomic-macos-gateway-releases.zh.md)

## Problem

A launchd job can retain an old release as its cwd while `current` is changed to a new directory. When the Gateway command, runtime command, and policy-plugin paths each contain `current`, later child starts can resolve a different release from the still-running parent. Removing the old directory then turns an ordinary upgrade into a mixed-version process tree with no reliable rollback target. Process liveness and a basic `{"ok":true}` health response do not detect this state.

## Decision

Forward-only database migrations can make the release that ran before activation unable to read the database. Process history therefore cannot select a compatible recovery directory. Operators establish database compatibility separately; release payload validation does not read, migrate, or downgrade the database.

The macOS deployment installs `gateway/deploy/macos/release-control.sh` in a stable control directory outside every release. launchd runs that stable copy with the releases root as its working directory. The controller resolves `current` once at Gateway start, exports the canonical target as `HGW_RELEASE_ROOT`, removes independently configured Gateway, CLI, repository, and policy-plugin paths, and starts the compiled Gateway entry from that same target. The production build creates the relative `gateway/node_modules/@deepseek-ai/*` links required by the standalone Gateway package — one per workspace package in `GATEWAY_RUNTIME_PACKAGES` in `scripts/build-production.ts` — and activation validates each emitted payload file and every runtime link before switching `current`. The launchd `run` path accepts an already-current source-only legacy release for implicit recovery; explicitly selected activation and recovery targets require compiled payloads.

When `HGW_RELEASE_ROOT` is present, Gateway configuration verifies that the running Gateway directory belongs to that release, derives the built CLI command and release-owned plugin paths from it, and rejects conflicting overrides. `/healthz` reports the immutable directory name as `release` without exposing its absolute host path.

Release activation validates the required production payload, holds one filesystem lock, atomically replaces the `current` symlink, and forces a launchd restart. It accepts the target only after launchd has a different PID, that PID's cwd is the target Gateway directory, and `/healthz` reports the target release. Failure restores the previous release unless `--rollback-target <directory>` selects a distinct recovery release, restarts launchd again, and verifies the selected release before returning an error.

An explicit recovery target is fixed before process operations and must resolve to a complete compiled release directly under the releases root. The mutable `current` name is rejected before canonical resolution; aliases that resolve to the candidate are also rejected. Previous PID and child-process cleanup always follow the actual running release, independently of recovery selection. If the selected recovery target is unhealthy or reports another release identity, the controller returns an error without trying the potentially incompatible previous release.

Activation never removes releases. The explicit prune operation rejects `current`, the live Gateway cwd, a directory named in another process command, and a directory with open files. Operators retain at least the previous verified release until a later explicit prune.

## Verification

Gateway configuration tests cover canonical release derivation and conflicting-path rejection. Server tests cover release-aware health responses. [macOS controller tests](../../../../gateway/tests/macos-release-control.spec.ts) cover one-time path resolution, successful activation, implicit and explicit recovery, rejection before mutation, recovery identity failure without an extra restart, and refusal to prune a release still used by the live Gateway after `current` points elsewhere. Process-control fixtures intercept both external commands and Bash's builtin `kill`; these tests establish payload and controller behavior, not database compatibility.

## Alternatives considered

**Keep `current` in the plist and require a manual restart.** This leaves correctness dependent on operator ordering and permits launchd to keep a healthy-looking parent alive across a symlink change.

**Pin only the child runtime command.** This prevents one mixed CLI path but still lets the Gateway source, policy plugins, and future release-owned inputs resolve independently.

**Always restore the last running release.** Process history does not prove compatibility after a forward database migration. Explicit recovery selection keeps shutdown tied to the real previous process while allowing restoration to software verified against the current database.

**Delete older releases automatically after activation.** Automatic cleanup reduces disk use but couples a destructive operation to the highest-risk part of deployment. A separate guarded prune keeps rollback available and makes deletion require current process evidence.

## Consequences

The macOS production layout needs one stable controller copy and one owner-controlled environment file in addition to release directories. Activation fails closed when payloads, launchd state, cwd, database readiness, or release identity disagree. Disk cleanup becomes an explicit step, so operators trade small temporary storage growth for deterministic rollback and the guarantee that a live process never loses its release directory through the supported workflow.
