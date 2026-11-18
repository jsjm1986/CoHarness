# Agent Note: Gateway Windows native spec lane

Status: implemented

English | [中文](2026-11-15-gateway-windows-native-spec-lane.zh.md)

## Problem

The Gateway suite ran only in the Linux `gateway` CI job, so every spec body gated on `process.platform === 'win32'` had no lane: the Job Object and creation-instant branches of [local-runtime-win32-job.spec.ts](../../../../gateway/tests/local-runtime-win32-job.spec.ts), the Windows ACL branches of the node-private specs, the `schtasks` and named-pipe paths of `node-agent.spec.ts`, and [run-windows-principal-clock.mjs](../../../../gateway/tests/run-windows-principal-clock.mjs) — which asserts `platform === 'win32'` and therefore ran nowhere at all. The [Windows Runtime Job ownership note](../architecture/2026-11-12-windows-runtime-job-ownership.md) records the cost: the first live exercise of the Job/creation paths was the production node, which caught a `readBigUInt64LE` bounds error in the FILETIME decode. Running the whole suite on Windows is not the fix — most fixtures assume POSIX facilities (`flock`, `getuid`, POSIX paths) and several lanes need a PostgreSQL service Windows runners cannot host, so a broad `npm test` would be predictably red for reasons unrelated to the Windows code under test.

## Decision

`.github/workflows/ci.yml` gains a `gateway-windows` job that owns the Windows-meaningful slice and nothing else. It reuses the `windows-native` pool selector verbatim — `windows-2025` by default, the named enterprise pool under `DSH_CI_ENTERPRISE_RUNNERS_ENABLED`, the `[self-hosted, dsh-win-ci, windows]` failover under `DSH_CI_FAILOVER_WINDOWS=selfhosted` for same-repository non-Dependabot pull requests — so pool policy stays in one decision. The lane installs `gateway/` with `npm ci`, installs the workspace with `--ignore-scripts` exactly as the Linux `gateway` job does for declaration emit, runs `pnpm run build:native-system && pnpm run build:lib:host` to emit the graph the vitest aliases consume, then runs `npm test --prefix gateway --` with an explicit file list: the twelve spec files whose bodies contain `win32` branches or cover Windows-owned sources (`config-windows-paths`, `local-runtime-{win32-job,launcher,native-control,owner,owner-acl-cache,protocol,reboot}`, `node-access-config`, `node-agent`, `node-private-{file,sqlite}`). POSIX-only bodies inside those files self-skip via `skipIf`, so the same command stays green on POSIX hosts for local rehearsal. A `npm run build --prefix gateway` step then emits `lib/` and `node tests/run-windows-principal-clock.mjs` executes the principal-clock proof natively.

Triggering follows the two independent signals that make the lane worth its minutes: `gateway_mode == 'full'` — shared Gateway code can regress Windows behavior without touching a Windows-owned file — or `proof_native_windows`, plus every master push, the nightly schedule, and `full-audit` dispatches so coverage never waits for a pull request. `all checks passed` requires the job whenever either condition holds; `scripts/verify-pr-results.ts` derives that requirement from the same `gatewayMode`/`nativeWindows` plan fields the workflow reads, and `scripts/ci-workflow.spec.ts` records the push-reachability set the job joins.

## Verification

The curated command ran locally: all twelve spec files pass on macOS (103 tests, 5 self-skipped POSIX/Windows-only bodies), proving the file list resolves and the gate is rehearsal-able off Windows. `ci-workflow.spec.ts` and `verify-pr-results.spec.ts` cover the trigger and admission logic — 71 workflow-script tests pass. The remaining proof is the lane itself running on `windows-2025`: it is the first CI execution of the win32 spec bodies, so a green first run is itself evidence, and a red one surfaces exactly the latent defects the lane exists to catch.

## Alternatives considered

**Run the full `npm test` on Windows.** Rejected — POSIX-assuming fixtures and the PostgreSQL service lanes would fail for reasons orthogonal to Windows correctness, burying real signal.

**Extend the Wine lane.** Rejected — Wine cannot provide kernel Job Objects, `Get-Acl` semantics, named pipes, or `schtasks`; it already serves as the PR smoke and is documented as not equivalent to native verification.

**Host PostgreSQL on the Windows runner.** Rejected — Windows-hosted runners cannot run the Linux `postgres` service container, and the PostgreSQL lanes exercise database behavior, not Windows-specific code; the Linux `gateway` job already owns them.

## Consequences

Every Windows branch in the selected specs now has a CI lane, and `proof_native_windows` changes exercise real branches on the pull request instead of only in production. The spec list is deliberately a workflow-visible allow-list: a new spec with win32 bodies joins the lane by being added to the list — it does not run automatically, which keeps the lane scoped to files whose bodies actually gate on platform. PostgreSQL-backed specs remain Linux-owned; none of them gate on `process.platform`.
