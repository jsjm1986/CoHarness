# Agent Note: Upstream fs-patch absorption

Status: implemented

English | [中文](2026-11-25-upstream-fs-patch-absorption.zh.md)

## Problem

The upstream rc.3 apply-patch feature requires a Codex-style patch parser and LF text updater, but the local tree had no equivalent primitive and the apply_patch tool cannot land without it.

## Decision

Absorb upstream `packages/fs/fs-patch` (dsh-v0.2.2-rc.3) verbatim: a pure patch parser (`parsePatch`) and LF text updater (`applyHunks`) with structured match failures and zero runtime dependencies. The library is registered in `tsconfig.host.json` and the fs group README table.

## Consequences

- `dsh-fs-patch` ships as a library package consumed by [the fs mutation vocabulary and apply_patch batch](2026-11-25-upstream-fs-mutations-and-apply-patch.md): `fs-local`'s `patchText` and the `apply_patch` tool build on `parsePatch`/`applyHunks`.
- The parser enforces LF-only input and reports `ParsePatchError`/`ApplyHunksError` with hunk and line context; callers surface them as structured tool output.

## Alternatives considered

- **Hand-port only the hunk-application half** — rejected: the parser and updater interlock on the same structured-failure contract, and the file has no `ctx.fs`, cordis runtime, or provider coupling, so file-for-file absorption carried no porting risk.

## Verification

- `pnpm exec vitest run packages/fs/fs-patch` — 147 tests pass (upstream suite unchanged).
- `pnpm exec tsc --noEmit -p packages/fs/fs-patch/tsconfig.json` — clean.
