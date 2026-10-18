# Agent Note: Activation validates Gateway runtime links and model-governance peers unpin

Status: implemented

English | [中文](2026-10-19-release-runtime-links-and-governance-peers.zh.md)

## Problem

Two defects surfaced on the same production release. `dsh-model-governance` declared exact `0.1.5-alpha.1.coharness.1` peer dependencies while the product line had moved to `0.2.1-rc.1.coharness.1`, so the plugin loader disabled it in every agent session with an incompatibility warning — model authorization and usage reporting never ran. Separately, `validate_release` in `release-control.sh` checked payload files but not the `gateway/node_modules/@deepseek-ai/*` links the compiled ESM graph resolves through. A release assembled without `build:production`, the step that creates those links, passed payload validation, switched `current`, and only then failed to boot on an unresolved import — the defect reached the live health check instead of being refused at activation.

## Decision

The plugin's `peerDependencies` use `*`, matching `dsh-directory-guard` and `dsh-steward-tools`. Exact pins were maintained by hand and went stale on every version bump, silently disabling a shipped plugin; the loader check remains as the compatibility gate for ranges that are maintained.

`validate_release` now additionally requires each scoped runtime link to resolve to a package manifest. The checked names mirror `GATEWAY_RUNTIME_PACKAGES` in `scripts/build-production.ts` — `cordis`, `schemastery`, and the nine `dsh-*` workspace packages the compiled Gateway imports — so a release assembled without the links is refused with the missing entry named before `current` moves.

## Alternatives considered

**Pin peers to the current release version.** Rejected: the same stale-pin failure recurs on the next bump because nothing regenerates the values; `*` states the actual contract — the plugin ships inside the release it was built with.

**Keep links out of payload validation and rely on health-check rollback.** Rejected: the incomplete release boots and crashes before the rollback path restores the previous one, so a payload defect becomes a live outage window; refusing it up front keeps activation atomic.

## Verification

`bash -n` passes on the edited controller. A stubbed `activate` against a fabricated release directory with every required payload file but no runtime links is refused naming the missing link; adding all eleven links lets activation proceed past validation to the launchd and health-verification stage.

## Consequences

The governance plugin loads under any release version, so version bumps can no longer silently drop model authorization and usage reporting; genuine API incompatibility stays a build and typecheck concern rather than a loader concern. The link list is duplicated between the TypeScript build script and the shell controller — a `GATEWAY_RUNTIME_PACKAGES` addition must update the shell array; the comment there points at the authoritative list.
