# Agent Note: Upstream fs-patch absorption

English | [中文](2026-11-25-upstream-fs-patch-absorption.zh.md)

Status: implemented

## Decision

Absorb upstream `packages/fs/fs-patch` (dsh-v0.2.2-rc.3) verbatim: a pure Codex-style patch parser (`parsePatch`) and LF text updater (`applyHunks`) with structured match failures, zero runtime dependencies.

## Rationale

The library is self-contained — no `ctx.fs`, cordis runtime, or provider coupling — so wholesale file-for-file absorption carries no porting risk and lands the apply_patch primitive the fs feature batch depends on (upstream `tool-fs` `apply_patch` plumbing builds on it). The local `ctx.fs` Service Definition currently exposes no move/delete/patch operation, so the library ships unconsumed until the apply_patch tool lands; it is registered in `tsconfig.host.json` and the fs group README table as a library package.

## Verification

- `pnpm exec vitest run packages/fs/fs-patch` — 147 tests pass (upstream suite unchanged).
- `pnpm exec tsc --noEmit -p packages/fs/fs-patch/tsconfig.json` — clean.

## Deferred

- apply_patch tool and `ctx.fs` move/delete/patch operations: remain in the fs feature batch pending Service Definition changes.
