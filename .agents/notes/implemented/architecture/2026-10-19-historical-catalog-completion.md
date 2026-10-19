# Agent Note: Historical catalog completion binds explicit child evidence to V6→V7

Status: implemented

English | [中文](2026-10-19-historical-catalog-completion.zh.md)

## Problem

A V6 parent's `subagent/catalog` facts record the direct children it knew at write time. Restoring that parent to V7 must fill catalog gaps from the retained child logs themselves; a parent alone cannot recover child ids, creation times, or descriptors it never recorded. Silently supplying no evidence dropped real children from restored sessions and left listings blind to descendants whose headers the parent never wrote.

## Decision

Historical body restoration through `sessionFormatV6ToV7` requires explicit child evidence. The shared default edge refuses body restoration without that binding, so no restore path can silently produce an incomplete catalog; an empty array explicitly declares a childless parent. `createSessionFormatV6ToV7(children)` binds one parent's evidence; `createSessionFormatCatalogWithChildren` and `createCoharnessJsonlFormatCatalogWithChildren` assemble the catalog for it, the latter keeping CoHarness v0–v3 dialect admission on the same bound edge.

`dsh-session-persistence-jsonl` collects that evidence in `catalog-migration.ts`: it reads every retained direct child through `historicalSessionFormatCatalog` (V0–V6 with dialect support), extracts each child's `subagent/descriptor` fact, witnesses the child's physical identity, and isolates a corrupt or unreadable child into an `unavailable` fact instead of failing the parent. The prepared migration validates every witnessed identity again before serving or publishing, and a `JsonlGenerationSourceChangedError` during read-open triggers one recollection retry.

Two read-side behaviors changed with it. Historical `stat` and `list` revisions now fold `historicalCorpusRevision` — a SHA-256 over sorted selected generation paths and their physical identities — so child membership or content changes invalidate cached results. Listing enumeration runs through a bounded limiter (`listConcurrency`, default 3) shared by project scans, header reads, stat calls, and the corpus hash; `list` skips foreign or corrupt artifacts while targeted opens still refuse them, and `SessionLogScanner.finish` asserts the released V7 lifecycle relationships on every stored-log read.

## Alternatives considered

**Let the default edge accept missing evidence as an empty child set.** Rejected: silent emptiness is exactly the defect being removed. Header-only migration stays unconditional; body migration without evidence refuses loudly so readers cannot drift.

**Discover children by scanning the corpus at migration time without witnesses.** Rejected: the corpus can change between collection and publication, so each child descriptor is bound to the physical file identity that produced it and revalidated at the commit point.

**Keep legacy headers on the released codecs inside `historicalSessionFormatCatalog`.** Rejected: retained CoHarness v0–v3 children carry the dialect framing, so the historical catalog dispatches legacy headers to a dialect catalog and released headers to the released one through the same `createCoharnessJsonlCatalog` split used by the current reader.

## Consequences

V6→V7 reads and publications produce parent catalogs that reflect the retained child corpus, including empty sets declared explicitly. `sessionFormatCatalog` and `coharnessJsonlFormatCatalog` remain valid for header and current-generation reads but refuse historical body migration without bound children; logical backends use `sessionLogicalFormatCatalog`, whose stored metadata is itself the complete evidence. A deleted or rewritten child fails targeted reads instead of silently changing the restored parent.

## Verification

`catalog-migration.spec.ts` covers parent–child composition across V0–V6 sources, publication with source preservation, malformed native catalog rows, foreign delivery markers, duplicate catalogs, membership and content revision invalidation, disappearing and repaired children, opaque successors, corrupt-child isolation with path diagnostics, missing or multiple descriptors, unsupported child generations, and same-read recollection. `children.spec.ts` pins the refusing default edge and the bound-evidence contract; `generation.spec.ts`, `jsonl.spec.ts`, and `zstd.spec.ts` cover bounded listing, read retry, corruption-tolerant enumeration, and current-generation lifecycle validation.
