# Agent Note: Release validation requires the session-format payload

Status: implemented

English | [中文](2026-09-17-release-session-format-payload.zh.md)

## Problem

The compiled Gateway's `runtime-api.ts` imports `@deepseek-ai/dsh-session-format` and its `/surface` subpath, and `build:production` already emits the `gateway/node_modules/@deepseek-ai/dsh-session-format` link and requires the built `lib/index.js`. The macOS release controller's `validate_release` and the deploy layout instructions still named only `dsh-llm`, so a release missing the session-format payload passed activation and failed later at request time.

## Decision

`validate_release` requires both `packages/session/session-format/lib/index.js` and `lib/types/surface.js` before switching `current`, matching the two specifiers the compiled graph imports. The deploy README names the additional `packages/session/session-format/` copy step and the generated link.

## Alternatives considered

**Trust the build to stay self-describing.** Rejected: the controller validates the release tree on a host that only receives copied directories; a missing sibling package is invisible until the runtime import executes.

**Validate every workspace import.** Rejected: `GATEWAY_RUNTIME_PACKAGES` in `build-production` is the single enumerated owner of the standalone graph's package list; mirroring it keeps one fact in one place.

## Consequences

A release that lacks the session-format payload is refused before `current` moves, preserving the rollback target. The legacy source-only release remains acceptable as a rollback target. A future workspace package added to `GATEWAY_RUNTIME_PACKAGES` must extend the same check list and the deploy copy step together.

## Testing

`gateway/tests/macos-release-control.spec.ts` rejects a compiled release missing either emitted file before the `current` switch, and the existing activation, rollback, and prune cases still pass.

## Related

- [Atomic macOS Gateway releases](../process/2026-08-18-atomic-macos-gateway-releases.md) — the controller contract this validation extends.
