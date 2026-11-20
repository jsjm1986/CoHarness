# Agent Note: Diff-scoped Android build gate on pull requests

Status: implemented

English | [中文](2026-11-19-android-build-pr-gate.zh.md)

## Problem

The `android-build` job ran only through the manual `android-audit` workflow_dispatch suite, so pull requests touching `apps/android-shell/` or its registered consumer inputs merged without any compile check. That gap let a duplicate `jpushConsentGranted` method reach `master` in the UnifiedPush change and break `assembleDebug` for every later checkout; nothing in the required path could have caught it.

## Decision

`androidMode` is now a real consumer mode (`'skip' | 'full'`) resolved by the same input rules as the Gateway and Admin UI lanes: `apps/android-shell/**` changes and paths matching the registered `android` consumer relations select `full`. `android-build` joins `pr-scope`'s needs, triggers on pull requests when the scope selects it (the `workflow_dispatch` `android-audit` suite still works), and joins the `all-checks-passed` needs set so `verify-pr-results` requires its evidence whenever the plan selects it. The scope carries the mode through `validation_plan.scope.androidMode` into `requiredPrJobs` via a new `scopeJobs` entry.

The emulator-dependent `android-bridge` job stays manual-only: hosted KVM runs are too slow and fragile for a required diff gate, while the debug build, lint, unit tests, and the instrumented androidTest APK compile inside `pnpm run check:android` cover the failure class that slipped through.

## Alternatives considered

**Keep Android manual-only and fix compile breaks reactively.** Rejected — the duplicate-method break proved the loop fails silently: the break sat on `master` until a release build attempted it, and every reactive fix costs a separate PR while leaving all checkouts broken in between.

**Require the emulator bridge too.** Rejected for now — KVM-dependent instrumentation is the flake-prone half of the lane and would add tens of minutes to the required path; the build job alone catches compile, lint, and unit-level regressions, which is where the observed break lived.

**Gate on all diffs unconditionally.** Rejected — an Android SDK + Gradle lane costs minutes and a runner for PRs that provably cannot reach the shell; the diff-scoped consumer model already exists for exactly this trade-off.

## Verification

`classifyCiPrScope` returns `androidMode: 'full'` for `apps/android-shell/**` and consumer-rule paths such as `apps/web/src/native-push.ts`, `'skip'` for unrelated or inert paths, and `'full'` for the empty/unknown-diff fallback; `ci-consumer-relations.spec.ts` pins each direction. `requiredPrJobs` maps `androidMode: 'full'` to the `android-build` job and `verify-pr-results.spec.ts` requires it in the full-consumer set. `gate-workflow-wiring.spec.ts` pins the PR trigger branch, the `pr-scope` need, the verdict membership, and `android-bridge`'s unchanged manual-only condition.

## Consequences

A PR whose diff reaches the shell or a registered Android consumer now blocks on the debug build and lint, so compile regressions cannot land silently. Non-Android diffs skip the lane at no cost. The manual `android-audit` suite continues to run the emulator bridge; a future note can revisit promoting it if hosted KVM reliability improves.
