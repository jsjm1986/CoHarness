# Agent Note: Stable repository file discovery on Node 24

Status: implemented

English | [中文](2026-09-13-repo-file-dirent-walker.zh.md)

## Problem

Static and documentation gates used Node's `fs.glob` to enumerate repository files. Some Node 24 releases probe a path below a symlinked file while expanding `**` and throw `ENOTDIR`, making the gate depend on the runner's Node patch version.

## Decision

`scripts/repo-files.ts` now uses a dirent-based walker for the repository's supported glob subset. Wildcard and `**` traversal does not follow symlinked directories; literal segments retain the required stat behavior. Canonical realpath deduplication, hidden-file exclusion, broken-link failure, and unsupported-pattern rejection remain explicit. The walker is a CI utility and does not change product filesystem access.

## Consequences

Documentation and static gates enumerate the same corpus across Node versions and fail loudly when a pattern is outside the modeled subset. The nine focused tests cover symlink files and directories, cycles, broken links, dot names, canonical deduplication, and rejected syntax.

## Alternatives considered

**Keep `fs.glob`.** Rejected because the runner-dependent `ENOTDIR` failure can block unrelated pull requests.

**Follow every symlink.** Rejected because it changes the gate corpus and can recurse through cycles.

## Verification

`scripts/repo-files.spec.ts` passes with nine tests. The full static/document gate remains required before publishing.
