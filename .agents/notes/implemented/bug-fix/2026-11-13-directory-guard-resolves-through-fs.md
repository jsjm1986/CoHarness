# Agent Note: Directory guard classifies the filesystem backend's resolved target

Status: implemented

English | [中文](2026-11-13-directory-guard-resolves-through-fs.zh.md)

## Problem

[guard.ts](../../../../plugins/dsh-directory-guard/src/guard.ts) decided on its own view of a tool call's target. Tool recognition was a fixed name list (`read`, `write`, `edit`, `str_replace_editor`, `grep`, `glob`), so `read_image`, `lsp`, and `present` delegated through `next()` and read files outside every grant. Path canonicalization ran `path.resolve()` before `realpath`, which collapses `proj/link/../secret` to `proj/secret` lexically, while [fs-local](../../../../packages/fs/fs-local/src/fsio.ts) keeps the `..` and resolves it physically after following `link`; the guard therefore classified a path inside the grant while the backend opened a path outside it. Relative paths also used the Session header cwd instead of the Session working directory that the fs tools resolve against.

## Decision

The adapter resolves every checked path as `ctx.fs.processPath(await ctx.fs.resolve(path, { cwd }))`, with `cwd` from `ctx.workingDirectory.ensure(agent)`, and passes that resolver into `decideDeny`. The guard no longer canonicalizes paths itself, so the classified path is the canonical target the backend opens; a path the backend cannot resolve is denied. Tool recognition adds `read_image`, `lsp` (source file and the indexed workspace cwd), and `present` (every `files[].path`), and any other tool carrying a `file_path` argument is checked as a read, so a new file tool following the `file_path` convention is covered without a list edit.

## Alternatives considered

**Decorate `ctx.fs` and authorize every operation.** Rejected: harness-internal reads that are not tool calls (skill catalogs under `$DSH_HOME`, session persistence, spill) use the same service and live outside user grants, and `grep`/`glob` read through a ripgrep subprocess rather than `ctx.fs`, so an `ctx.fs`-only fence both breaks those readers and misses search. A per-execution fence would need the guard to own an execution-scoped context that the tool pipeline does not expose.

**Keep `canonicalize` and add tool names.** Rejected: the lexical-versus-physical mismatch would remain for every listed tool.

## Consequences

`dsh-directory-guard` injects `fs` and `workingDirectory` in addition to `tools`. Tools whose names collide with `Object.prototype` members and carry `file_path` are checked as reads instead of delegated. The Linux systemd mount namespace remains the authoritative boundary; this plugin is the primary in-process boundary on macOS.

## Verification

`plugins/dsh-directory-guard/tests/guard.spec.ts` resolves through `dsh-fs-local` and covers `read_image`, `lsp`, `present`, an unlisted `file_path` tool, a symlink followed by `..` for read, write, edit, and grep, and an unresolvable path. The mounted case runs the `tools/pre-execute` waterfall over a mounted `LocalFileSystem` with a working directory that differs from the Session header cwd.
