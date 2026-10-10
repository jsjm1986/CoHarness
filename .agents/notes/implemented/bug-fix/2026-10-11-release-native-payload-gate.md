# Agent Note: Release activation requires the host native addon payload

Status: implemented

English | [中文](2026-10-11-release-native-payload-gate.zh.md)

## Problem

`validate_release` enumerated the compiled Gateway, Web, Admin, plugin, and library payloads but not the `native/system` build outputs. The flock binding `bin/system.node` and the Landlock launcher are gitignored artifacts, so a release assembled from `git archive` plus selective copies silently lacked them. `flock.js` lazy-requires the platform package only on the first lock acquisition, so such a release passed activation, reported healthy on `/healthz`, and failed later at the first session lock — surfacing as `resume failed for session "…": Cannot find module '…/bin/system.node'` for every flock path, Agent Team resume included.

## Decision

`validate_release` requires the host platform's native payloads of any release presenting a complete compiled payload: `darwin-<arch>/bin/system.node` on macOS and `linux-<arch>/bin/{landlock-run,glibc/system.node,musl/system.node}` on Linux, resolved by `uname -s`/`-m` the same way `flock.js` resolves the package. The check sits inside the compiled-payload branch so a legacy source-only release — which predates the addon — remains usable as a rollback target. `deploy/README.md` names `native/system/` in the release copy list.

## Alternatives considered

**Require every platform package's binaries.** Rejected: a release built on one host legitimately carries only the host addon; CI builds the other platforms natively.

**Validate the whole `native/system` tree.** Rejected: the gate mirrors exactly what `flock.js` and the launcher resolve; entry JS is already covered by the compiled-payload check.

**Keep the gate at the top of `validate_release` for every release.** Rejected: it would have refused legacy source releases that `run_gateway` deliberately keeps restartable for rollback, breaking the documented escape hatch without improving safety — those releases never load the addon.

## Consequences

A compiled release missing the host addon is refused with the missing path named before `current` moves, so the previous release keeps serving; both `activate` and the launchd `run` path enforce it. The incident root cause — an assembly flow that copies source but not gitignored build outputs — is now caught at the gate instead of at the first session lock.

## Verification

`macos-release-control.spec` builds host-platform native payloads into compiled fixtures and rejects a release missing the addon before `current` switches; the legacy-rollback case still passes without the payloads. On the real host, `activate` against a release lacking `bin/system.node` fails with the missing path and leaves `current` untouched, while the deployed release's `tryLockExclusive` acquires and releases a lock through the copied binding.

## Related

- [Release validation requires the session-format payload](2026-09-17-release-session-format-payload.md) — the same checklist gap for a workspace package.
- [Atomic macOS Gateway releases](../process/2026-08-18-atomic-macos-gateway-releases.md) — the activation ordering this gate guards.
