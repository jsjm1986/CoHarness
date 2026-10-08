# Agent Note: Controlled dependency upgrades

Status: implemented

English | [中文](2026-10-08-controlled-dependency-upgrades.zh.md)

## Problem

Installer updates affect the bootstrap and packaging paths that consume pnpm. A pin-only classification exemption can omit those paths despite a green aggregate. Vitest's mock and coverage packages share the runner's versioned APIs; an isolated `@vitest/spy` 5.0.0 proposal with root Vitest 4.1.8 (#261) mixes that family. Daily independent proposals also need explicit repository review capacity.

## Decision

[`scripts/verify-dependency-cohorts.ts`](../../../../scripts/verify-dependency-cohorts.ts) reads the `pnpm-lock.yaml` importer table and rejects when any directly declared `vitest` or `@vitest/*` entry resolves a version different from the root `devDependencies.vitest` record (peer-dependency suffixes are ignored). It runs inside `pnpm run constraints` and as its own `pnpm run verify-dependency-cohorts` step in `ci.yml`'s `pr-scope` job — after the classifier runtime install and before scope classification — so a drifted family fails before lanes are selected.

The same preflight runs the source-only [CI workflow contracts](../../../../scripts/ci-workflow.spec.ts) before scope classification. A failed workflow assertion prevents the consumer matrices from being selected. The preflight runs unconditionally and cannot continue after an assertion failure.

Browser verification retains failing screenshots, DOM and fixture policy evidence from the pull-request, post-merge sweep and manual full-audit entry points. Their failure-only uploads include hidden files and use attempt-scoped names, so reruns preserve earlier failure artifacts. An entry that fails before producing browser evidence reports the missing files without replacing its original failure.

Installer-only diffs select their runtime and platform consumers. [`scripts/ci-pr-proofs.ts`](../../../../scripts/ci-pr-proofs.ts) determines required proofs from changed paths rather than a candidate's `reason` field. Credential-bound proofs are explicitly withheld from untrusted actors. The frozen baseline retains its historical `action-only` reason for comparison; default `shadow` execution combines its selection with the active candidate.

[`.github/dependabot.yml`](../../../../.github/dependabot.yml) owns the weekly version-update schedule, per-ecosystem pull-request limits, and `vitest` and `bundled-pnpm` update groups. Vitest-family, pnpm, and `@vitejs/plugin-react` major upgrades require reviewed migrations; unrelated majors remain eligible. The exact `pnpm/action-setup` version `6.1.0` is held pending macOS Intel bootstrap verification (#254), not as a verdict on the 6.x line. Version 6.0.10 also self-updates pnpm.

## Alternatives considered

- **Suppress Dependabot and upgrade by hand.** A manual queue loses automated maintenance discovery and still needs consumer verification.
- **A dedicated installer-verification workflow.** The existing workflow-input proof owners (`release.yml`, `release-vendor.yml`, `landlock-run.yml`, `sandbox.yml`) already cover the surface an installer bump can break; a new lane would duplicate them.
- **Treat `pnpm/action-setup` 6.1.0 as proven-bad forever.** The evidence is a pending macOS Intel acceptance check, not a confirmed incompatibility; the hold names the exact version so 6.1.1+ proposals are judged on their own result.

## Consequences

Version coherence is a prerequisite, not proof of API compatibility. Every selected consumer must pass; credential-withheld and unsupported proofs remain explicitly unexecuted. A Vitest-family upgrade moves all directly declared members together.

[Path-gated PR CI](2026-09-06-path-gated-pr-ci.md) and [CI lane scope classification](2026-09-10-ci-lane-scope-classification.md) retain the conservative selection and independent lane-reporting decisions. This note owns dependency grouping, holds, and installer proof requirements. [The bundled-pnpm decision](2026-10-07-pnpm-is-a-bundled-runtime-component.md) retains its independent JavaScript distribution requirement.
