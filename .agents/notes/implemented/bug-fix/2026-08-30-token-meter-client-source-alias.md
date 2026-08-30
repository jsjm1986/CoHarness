# Agent Note: Keep token-meter client imports resolvable in source tests

Status: implemented

English | [中文](2026-08-30-token-meter-client-source-alias.zh.md)

## Problem

Client conversation code now executes `deriveTurnTokenUsage` from `@deepseek-ai/dsh-token-meter/client`. The package export points at emitted `lib/types/client.js`, which is absent before a build in a clean checkout; source-plane Vitest then failed before any test could run even though a previously built workspace passed locally.

## Decision

Add an exact `tsconfig.base.json` path entry for `@deepseek-ai/dsh-token-meter/client` that resolves to `packages/llm/token-meter/src/client.ts`. The source-plane alias follows the existing client subpath aliases, while published consumers continue to use the package export and its built artifact.

## Verification

The client conversation and token-meter focused tests pass with the source resolver; the serial macOS sandbox parity failure is eliminated by the alias in a clean-install checkout. Typecheck, lint, package-path, runtime-closure, and built-package checks continue to pass.

## Alternatives considered

**Build every package before source tests.** Rejected because source-plane tests must not depend on ignored artifacts, and the affected package is valid without a prior build.

**Change the package export to point at source.** Rejected because published consumers require the emitted `lib/types/client.js` entry and package exports must remain artifact-safe.

## Consequences

Source tests no longer depend on ignored build output. The package export remains unchanged, so artifact consumers still exercise the same generated client entry.
