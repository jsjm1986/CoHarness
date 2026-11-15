# Agent Note: Test-only headlessStartup stub for overlay compositions

Status: implemented

English | [中文](2026-11-16-headless-startup-test-stub.zh.md)

## Problem

rc.3 made `sandbox-policy` declare `inject: [headlessStartup]` so its `!!js` config expression can read `ctx.headlessStartup.additionalWritableRoots`. Seventeen test overlays intentionally disable the production `headless-startup` row; with the service absent, `sandbox-policy` could not resolve its injection and every dependent plugin (`fs`, `workingDirectory`, shell, PTC, subagent, and more — 22+ rows) went pending, cascading dozens of unrelated test failures across headless, sdk, and example compositions.

## Decision

- Keep the production `inject` intact — the dependency is real in shipped profiles.
- Add a test-only provider, `packages/test-support/loader-smoke/tests/fixtures/headless-startup-stub.ts`, that provides the minimal `headlessStartup` service shape (`cmdlineArgs`-free, empty writable roots).
- Each affected overlay keeps its production row untouched and appends one entry mounting the stub.

## Consequences

- Overlays that disable `headless-startup` no longer cascade; the same fix self-heals any future overlay with that combination.
- The stub is test infrastructure only: it lives under `test-support/loader-smoke` fixtures and is never shipped or mounted by a product profile.

## Alternatives considered

- Weakening `sandbox-policy`'s `inject` or replacing the entry `name` in overlays — rejected: `name` is the row identity and the dependency is genuine in production; weakening it would hide exactly the coupling the inject exists to declare.
- Providing `headlessStartup` per test driver — rejected: 17 overlays across three roots share one need; a fixture plugin is driver-independent.

## Verification

- Previously cascading tests pass: `cordis-inspection`, `pi-ai-conversation-updates`, loader-composition, headless `keyless-smoke`, sdk `keyless-smoke` (20/20), `ptc.e2e`.
- Full snapshot suite: 379/380 green (1 platform skip).
