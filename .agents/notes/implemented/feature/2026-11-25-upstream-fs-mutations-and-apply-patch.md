# Agent Note: Upstream fs mutation vocabulary and apply_patch absorption

Status: implemented

English | [中文](2026-11-25-upstream-fs-mutations-and-apply-patch.zh.md)

## Problem

The upstream rc.3 feature set added service-level move/delete/patch mutations and the Codex-style `apply_patch` model tool, but the local `ctx.fs` Service Definition exposed only `writeText`/`editText` and the `dsh-fs-patch` library shipped unconsumed. Local fs divergence made wholesale file replacement unsafe: `fs-local` owns realpath-derived `targetKey` identity, guarded `readByteRange`, `watch`, POSIX physical traversal, `expandHomePrefix` home expansion, and bounded diff bases that upstream does not share. SSH helpers and clients validate each other's wire vocabulary strictly, so adding the three RPCs without a protocol bump would let stale helpers silently drop the new methods.

## Decision

Extend the `ctx.fs` Service Definition with `patchText`, `deleteFile`, and `moveFile` alongside `writeText`/`editText`, absorbing the upstream (dsh-v0.2.2-rc.3) provider implementations, sandbox fence, SSH wire vocabulary, and the `apply_patch` model tool at hunk granularity while preserving local divergences.

`FileSystem` gains three abstract methods that take the same optional `expected` version guard and `SandboxExecutionPolicy` parameter as the existing mutations. `fs-local` implements them over `applyHunks` (from `dsh-fs-patch`), non-recursive `removeFile`, and a destination-then-source move that locks both distinct targets in lexical `targetKey` order. `moveFile` is deliberately two effects, not a transaction: a source-removal failure after destination publication returns `sourceDeleted: false` with a structured `sourceFailure` instead of pretending atomicity. `fs-sandbox` fences all five mutations; a move checks both source and destination before either effect. `fs-ssh` maps the three operations to `fs.patch`/`fs.delete`/`fs.move` helper RPCs and bumps the helper wire protocol to 3. The `apply_patch` tool registers only under `enableApplyPatch` (default off), commits operations in order with truthful partial results, and contributes the `TOOL_APPLY_PATCH` prompt section (order 1350).

Host errno failures now classify through the exported `fsErrorFromErrno`/`FS_ERROR_CODES` pair, so every resolve/stat/list/read/write failure carries a stable `FsError` code and the SSH provider validates remote codes against the same list. A new `fs/delete-intent` waterfall joins the intent vocabulary: delete guards ride it, patch and move-source guards ride `fs/edit-intent`, and move-destination guards ride `fs/write-intent`.

## Consequences

- `FileSystem` implementers must add the three methods; every in-repo fake gained typed `Promise<never>` stubs or real behavior.
- Node errno failures are typed everywhere the local provider touches the host; code that pattern-matched raw `code` fields on thrown errors now sees `FsError` with the original as `cause`.
- SSH helpers older than protocol 3 refuse the hello handshake — deploy helper and client together.
- `apply_patch` stays opt-in; compositions that omit `enableApplyPatch` see no schema or prompt-section change.

## Alternatives considered

- **Replace local fs files with upstream versions wholesale** — rejected: would silently drop realpath identity, guarded byte reads, watch support, and physical-traversal semantics the local tests pin.
- **Keep the upstream `readByteWindow` name** — rejected: local `readByteRange` already provides the bounded-window primitive with FileHandle+`O_NOFOLLOW` guards; renaming would churn consumers for zero capability gain.
- **Model move as one atomic primitive** — rejected: neither the local staging protocol nor the SSH helper can atomically publish-and-remove across paths; honest `sourceDeleted` reporting preserves the invariant callers actually need.

## Verification

- `pnpm exec vitest run packages/fs` — 930 tests pass, including `patch-mutations.spec.ts` (local provider move/delete/patch coverage), `errno.spec.ts`, and the added sandbox fence matrix over all three modes.
- `pnpm exec vitest run packages/ssh` — 314 pass with helper fixtures and the three local-only specs updated to protocol 3.
- `pnpm exec vitest run packages/fs/tool-fs` — 474 pass, covering `apply_patch` registration, output/presentation, commit ordering, and partial-effect reporting.
- `pnpm run verify-cordis-catalog` — clean after registering `FsDeleteOutcome`/`FsMoveOutcome`/`FsMoveSourceFailure`/`PatchHunk` in `LINK_MAP`; generated `filesystem.md`/`.zh.md` committed.
- `pnpm run verify-translation-pairing` — 2181 pairs consistent; `verify-export-jsdoc` — clean.
