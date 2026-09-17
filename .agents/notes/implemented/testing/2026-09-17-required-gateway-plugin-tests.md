# Agent Note: Required Gateway plugin tests

Status: implemented

English | [中文](2026-09-17-required-gateway-plugin-tests.zh.md)

## Problem

Gateway plugin suites outside the root Vitest include patterns need explicit required CI execution; plugin-only changes also need Gateway integration checks.

## Decision

Root [`test:plugins`](../../../../package.json) runs the `dsh-directory-guard` and `dsh-model-governance` Vitest configs. [`run-gates`](../../../../scripts/run-gates.ts) runs each as a required check in `ci-primary`, `ci-linux-primary`, `ci-consumers`, `ci-consumers-scoped`, and `check-all`. Both configs use root [`tsconfig.base.json`](../../../../tsconfig.base.json) source paths and [`standardDecoratorPlugin`](../../../../vitest.shared.ts). Both plugin prefixes select the Gateway lane through the [scope policy](../../../../scripts/ci-scope-policy.json).

## Alternatives considered

**Gateway-only execution.** Rejected because the [standalone Gateway lane](../process/2026-09-15-standalone-gateway-lane-source-resolution.md) does not execute the plugin suites.

**Hand-maintained source aliases.** Rejected because root source paths already own workspace resolution; the shared decorator transform supports the reached sources.

## Consequences

Plugin failures block the owning aggregates without depending on built workspace output. The standalone Gateway lane retains its separate integration role.

## Testing

[`run-gates.spec.ts`](../../../../scripts/run-gates.spec.ts), [`ci-workflow.spec.ts`](../../../../scripts/ci-workflow.spec.ts), and [`ci-pr-scope.spec.ts`](../../../../scripts/ci-pr-scope.spec.ts) cover required execution, failed child processes, workflow ownership, and plugin-prefix selection. Both plugin suites pass locally. Gaps: source suites do not prove packaged-plugin loading or deployed shutdown; no hosted CI run is claimed.
