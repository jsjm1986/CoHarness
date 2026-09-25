# Agent Note: Upstream alpha.2 durable-layer re-platform

Status: implemented

English | [中文](2026-09-19-upstream-alpha2-durable-layer-replatform.zh.md)

## Problem

Phase 2B of the `dsh-v0.1.6-alpha.2` alignment is not a set of independent file gaps: the upstream Session durable layer was re-platformed between the fork's last sync (0.1.2-alpha.5-era) and alpha.2, and every remaining 2B gap bottoms out in that one atomic change. The local stack predates it end to end:

| Layer | Local (alpha.5-era) | Upstream alpha.2 |
|---|---|---|
| `session-format` | `SessionFormatCatalog.migrate`/`createStream`, batch artifacts | codec + `createRestore` streaming row decode, `SessionFormatEventRun` runs, `readHeader`/`encodeCurrent*` |
| Generation addressing | version inside header metadata (`parseHeaderMeta`, `meta.version`) | canonical filename `session.vN.jsonl`, `assertNoRetiredHeaderFields`, highest-generation selection |
| `session-persistence-jsonl` | inline migrate + verify | `generation.ts` + `storage.ts` + `migration-verifier.ts` + `worker.ts` (worker-thread verification), multi-edge publication, content admission |
| `session-persistence` | `openHandle`/`openHandleAsync` | `create`/`open(id, access, options)`/`stat`/`list`, `SessionPersistenceNotFoundError`, handle `.header`/`.events()` |
| Migration packaging | `catalog-default.ts` monolith v0→v4 | per-generation codec+migration packages composed by generated `session-format-catalog` |

Porting any leaf without the core strands it: `session-log-export`'s host archive was ported and reverted this session because it needs the upstream `SessionPersistence.open` handle API, and the jsonl generation layer imports codec packages directly.

## Decision

Adopt the upstream durable-layer architecture wholesale in one sequenced workstream, and ship the independent 2B pieces now.

Shipped in this change:

- `compaction` group synced to alpha.2: `compaction/summary-error` waterfall event (durable input recovery for failed summaries), `compactSurfaceRegion` recover/retry loop, `deepFreeze` relocation to `dsh-llm`, source-event/`CommandDefinitionId` branding, error-copy updates, README/doc-standard rewrites.
- New package `dsh-compaction-image-offload` (required row): projects `image/offload` events onto retained messages, listens on `agent/request-error` + `compaction/summary-error` for `IMAGE_OFFLOAD_REQUIRED` failures, replaces oldest images with placeholders and retries. Mounted as `image-offload` in `bundle/base/cordis.patch.yml`.
- New package `dsh-session-turn-outline` (required row): `turnOutline` projection unit over the session-projection seam. Mounted in `bundle/web-app/cordis.patch.yml`; registered in `tsconfig.host.json`.
- `session-format` gained upstream leaf modules `context.ts` (`SessionFormatEventCollector`), `filename.ts` (`sessionFormatLogFilename`/`parseSessionFormatLogFilename` canonical `session[.vN].jsonl` names), `sessionFormatVersion`, and the `SessionFormatEventRun` type.
- Manifest fixes: stale `zod` declarations removed from six packages, `dsh-attachment` added to `test-support/client-runtime` devDependencies, `dsh-util-values` peer/dependency duplication resolved in `compaction-basic`.

The re-platform executes in order: (1) upstream `session-format` core; (2) `session-format-v0-to-v1`/`-v1-to-v2`/`-v2-to-v3` verbatim; (3) new local `session-format-v3-to-v4` package carrying the sovereign v4 chunk-fold (`V3ToV4Stage`) plus a thin v4 codec wrapping the released v3 codec — required by `scripts/gen-session-format-catalog.ts`, which already reads `SESSION_FORMAT_VERSION = 4` and demands a complete adjacent chain; (4) `session-format-catalog` + regenerated `generated.ts` with v4 restore hooks and `message-projections` (`imageOffloadProjection` now exists); (5) `session-persistence` open/handle API and the jsonl/sqlite/gateway backends; (6) consumers (`coordinator`, `llm-replay`, `session-log-export` archive, `core/session`, `session-query`).

Intentional divergences confirmed: `session-format/src/surface.ts` (`SESSION_SURFACE_EVENT_TYPES`) stays — local wire surface vocabulary shared with gateway persistence, no upstream equivalent. `SESSION_FORMAT_VERSION = 4` stays — the v4 chunk-fold generation is sovereign, alpha.2 stops at v3, and the catalog becomes `currentVersion: 4` through the local v3→v4 edge package. The `session-log-export` client face keeps the local capsule-menu design and `shell.mobile.header.actions` slot; upstream's client redesign arrives with Phase 7A client-runtime alignment.

## Alternatives considered

- **Keep the batch catalog and bolt worker verification onto it.** Rejected: upstream's `createRestore` row-level decode is the admission point for content validation and torn-tail recovery; a hybrid would reimplement the restore layer anyway while forking the format contract.
- **Port archive.ts against `openHandle`.** Rejected: the upstream handle API is the durable seam's public contract; adapting the new consumer to the old seam would create a second migration target inside the same release.
- **Keep the catalog monolith instead of per-generation packages.** Rejected: the generated catalog and the jsonl generation layer import `session-format-v*-to-v*` directly; the monolith retires rather than surviving as a second implementation.

## Shipped surface notes

- The retired batch API has now deleted on contact: the `legacy-*` cluster (`legacy-types`, `legacy-json`, `legacy-chain`, `legacy-catalog`, `catalog-default`) and the `@deepseek-ai/dsh-session-format/legacy` subpath are gone. Coordinator, Gateway, and SQLite read stored decoded rows through `sessionLogicalFormatCatalog` in `session-format-catalog`, which projects logical headers onto the released requirements and routes the v2 edge through the declared CoHarness dialect stage onto the same released primitives.
- `SessionPersistence` gained the upstream handle contract (`create`/`open`/`flush`/`stat`/`list`, `SessionHandle`, `SessionAccess`, the upstream error vocabulary, and `storage-contract` helpers) while keeping the coordinator-era methods. The old service `create`/`list` collide with the new signatures and are renamed `createStored`/`listHeaders`; the backend SPI hook `list` is now `listStored`. `ContractSessionHandle` adapts the new handle onto coordinator primitives — lazy create, ownership, materialize-on-first-append, and erasing close already match upstream semantics — so jsonl, sqlite, and gateway satisfy the upstream contract suite (20 tests each) without a storage rewrite. `materializeDetached`/`discardDetached`/`listPending`/`isPending` are the new coordinator verbs the adapter needs.
- The upstream live-write contract (`live-write-contract.ts`, "no write handle means nothing persists") assumes handle-routed live writes; the local coordinator auto-persists every live session through `session/event`. That semantic arrives with the generation/storage/worker replatform, not the adapter.
- `packages/session/session-persistence-gateway` gained `materializeHeader` (header-only append) to satisfy handle `flush` on an empty create; the test transport accepts an empty batch as the materialization write.

## Consequences

- Phase 2B becomes one atomic durable-layer port plus the shipped leaf items; downstream phases consuming Session reads (session-query documents, llm-replay corpus, snapshot fixtures) unblock only after it lands.
- `session-log-export` archive enters with step 6; its local client face (`MobileHeaderAction`, mobile slot) is unaffected.
- `scripts/gen-session-format-catalog.ts` enforces the complete adjacent chain at generation time, so a partial port fails the generator rather than drifting silently.
- Local v4 migration logic moves verbatim into `session-format-v3-to-v4`; the legacy normalization inside the retired monolith is replaced by the upstream v0→v3 packages, which carry the same normalization.

## Verification

- `vitest run packages/compaction/`: 13 files, 247 tests pass (includes image-offload projection/offload and summary-recovery coverage).
- `vitest run packages/session/session-turn-outline`: 2 files, 16 tests pass.
- `verify-cordis-config`: 166 files pass (new mounts resolve against manifest dependencies).
- `verify-package-dependencies`: 291 packages, 733 host edges pass.
- `tsc -b` on touched packages: clean.
