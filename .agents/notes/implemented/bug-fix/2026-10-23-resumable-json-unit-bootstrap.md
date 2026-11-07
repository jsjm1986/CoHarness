# Agent Note: Resume interrupted per-record JSON bootstrap before publishing state

Status: implemented

English | [中文](2026-10-23-resumable-json-unit-bootstrap.zh.md)

## Problem

Legacy whole-unit import writes records individually. An I/O failure after one record creates a partial tree, while the ordinary existing-document rule suppresses later legacy import. A successful reopen can therefore omit retained legacy records.

## Decision

The [JSON backend](../../../../packages/storage/storage-json/README.md) validates all declared legacy tables and path-safe keys before writing migration metadata. `.legacy-bootstrap.json` stores a versioned `copying` state with the admitted source text before any record publication. Every load resumes that snapshot until all declared records and the global slot are copied, then atomically replaces the metadata with `complete`.

The completed marker is retained. Deleting migrated records cannot make an empty tree import the legacy file again. Invalid progress metadata or an invalid retained source refuses the load instead of exposing partial state. The legacy whole-unit file remains unchanged. Trees without migration metadata keep their existing-document precedence; partial trees created by an older implementation cannot be distinguished safely from deliberate edits.

## Alternatives considered

- **Treat the first record as migration completion.** Rejected: an interrupted import silently omits later records.
- **Merge legacy records on every load.** Rejected: deleted records reappear and local edits can be overwritten.
- **Replace the whole target directory.** Rejected: a pre-existing tree can contain unrelated files; replacing or deleting it would widen migration ownership.

## Consequences

An incomplete import retains one additional copy of its source and can replay record writes until completion. Readers see either a complete imported state or a failure. Per-record version acceptance, normal write ordering, and the backend's documented directory-fsync limitations remain unchanged.

## Verification

[Backend tests](../../../../packages/storage/storage-json/tests/json-backend.spec.ts) inject a second-record publication failure, reopen the unit, require both records and the global value, and verify subsequent deletions remain deleted. Invalid metadata and unsafe legacy keys reject before partial state is accepted.
