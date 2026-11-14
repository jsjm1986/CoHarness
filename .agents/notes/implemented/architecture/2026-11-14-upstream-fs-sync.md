# Agent Note: Upstream fs fixes absorbed from rc.2..v0.2.2-rc.3

Status: implemented

English | [中文](2026-11-14-upstream-fs-sync.zh.md)

## Problem

Upstream `rc.2..v0.2.2-rc.3` carried fs fixes worth transplanting, but most of the fs churn is feature-coupled (patch vocabulary, tool-executor refactor) and could not be absorbed file-for-file without dragging in unported surfaces.

## Decision

Three applicable upstream fixes were transplanted; the rest of the fs churn rides with the fs-patch/tool-executor absorption batch.

- **`~` expansion (`ae0dfd1003`, `32004176bf`)** — `expandHomePrefix` in `fs-local/fsio.ts`, applied only at the `resolve`/`lstat` entry points so a requested `~`/`~/` (or `~\` on Windows) reaches the home directory while `~user`, later `~` segments, and directory entry names stay literal.
- **Glob prefix pruning (`12f63eaf89` + `b1c8c9bbbc` + `ef284800b9` + `e8bdbbe823` + `f9ef03834a`)** — `buildGlobCommand` emits an ordered `--glob=!**` + `--glob={dirs}/` prune pair when every directory component of the pattern is a plain relative name outside VCS metadata and no `path` is given; an 8 KiB argv budget keeps oversized sets on the original traversal.
- **Read guidance wording (`15c9e6006b`)** — names sed/head/tail and line ranges in the `read` tool's system-prompt guidance.
- **Writable-root grant validation (`e6cd6fdc61`, `f8633966f5`, `41a1aa8a97`, `6b71dcad85`, `64ece4cac1`)** — already present: the PTC batch took the sandbox roots/policy files at rc.3 state (verified byte-identical).

## Consequences

`fs-patch`, `apply_patch`, `patchText`/`deleteFile`/`moveFile` on `ctx.fs` (we have none of these APIs), the ToolArgsError/FsError refactor, and the mutation-defaults work are a single entangled feature set; the patch-parser quadratic-trim fix (`88f5aa1d43`) lands with `fs-patch` itself. `SDK_RENDERERS`/`renderToolsSdk` were widened to `PtcProgramFormat` here only to keep the PTC batch's `'script'` format compiling; script-aware renderer content rides with tool-executor-ptc.

## Alternatives considered

- **Absorb the whole fs diff** — rejected: the mutation vocabulary, `apply_patch`, and executor refactors are a single entangled feature set; taking them piecemeal here would have shipped broken half-features instead of the fixes alone.

## Verification

`vitest run packages/fs/`: all suites pass, including the ported home-prefix matrix (78 tests, 1 Windows-gated skip) and real-rg pruning assertions.
