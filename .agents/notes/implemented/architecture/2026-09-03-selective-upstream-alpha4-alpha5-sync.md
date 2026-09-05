# Agent Note: Selective upstream alpha.4 and alpha.5 integration

Status: implemented

English | [中文](2026-09-03-selective-upstream-alpha4-alpha5-sync.zh.md)

## Problem

The upstream `dsh-v0.1.2-alpha.4` tag changes the session protocol rather than adding features beside it: `Session.events` becomes an on-demand read API, `SessionSeq` and `SessionLogOffset` brands run through the whole session stack, the persistence header replaces `seedLength` with `{ meta.isSeeded, inheritedEventCount }`, and the one-way `report` tool is replaced by the bidirectional `send_message` steer service. `dsh-v0.1.2-alpha.5` adds one upgrade-path fix for the upstream per-record projection cache layout. CoHarness shares no Git ancestor with those tags and owns its own ApiProxy history wire, Gateway and SQLite persistence backends, UI façade, and tree-external plugins that read `session.events`. Picking release-note items by hand cannot carry a protocol change through fork-owned packages, and a textual merge of the whole tree would overwrite those owners.

## Decision

The fork integrates both tags with a file-level three-way merge (`git merge-file` with the upstream alpha.3 version as base, the fork version as ours, and the upstream alpha.5 version as theirs) and resolves the 245 conflicted files hunk by hunk; fork-owned packages that upstream never touched are adapted until `typecheck` is clean. The complete matrix lives in [`UPGRADE-PLAN-dsh-v0.1.2-alpha.4-alpha.5.md`](../../../../UPGRADE-PLAN-dsh-v0.1.2-alpha.4-alpha.5.md); the machine-readable inventory is [`UPGRADE-MANIFEST-dsh-v0.1.2-alpha.4-alpha.5.json`](../../../../UPGRADE-MANIFEST-dsh-v0.1.2-alpha.4-alpha.5.json).

The shipped code adopts these upstream behaviors:

- `Session` exposes `seq`, `eventAt()`, `snapshotEvents()`, `ownEvents()`, and `isOwnSeq()` with immutable snapshot reuse. A `@deprecated get events()` returns the cached snapshot so tree-external plugins keep compiling and running at zero cost; fork-owned call sites migrate to `snapshotEvents()`.
- `SessionSeq` and `SessionLogOffset` are branded through `dsh-session`, every persistence backend including the fork's SQLite and Gateway providers, projection and projection cache, titles, subagents, agent loop, token meter, goal, schedule, the ApiProxy history wire, and the SQLite migration script. `dsh-brand` adds the `BrandedNumber<B>` type only; the fork keeps cast factories instead of upstream's runtime `brandNumber`/`brandString`. Client `ConversationNode.seq` stays a plain number, as upstream's client does.
- Storage metadata is `{ meta: { isSeeded }, inheritedEventCount }`. JSONL decodes the v0 `seedLength` header bytes compatibly, SQLite maps the `seed_length` column, and the Gateway wire header keeps `seedLength` because the Gateway schema is authoritative; `session-persistence-gateway` owns the `GatewayWireHeader`/`wireHeader()`/`storageFrom()` mapping.
- The `report` tool and its package are removed. `tool-subagent-control` gains `send_message` addressed by `agent_id` with steer semantics, `dsh-subagent` exports `queueHostSubagentPrompt` from `./internal`, and `host/apiproxy` and `experimental/agent-team` queue browser and team prompts through it. Upstream's Remote `control.ts` remains unused.
- Model discovery accepts profile `headers` on `LlmEndpointModelDiscoveryRequest`, `llm-pi-ai` carries `StoredModelDiscoveryProfile { headers, resolveApiKey }`, and the model catalog picker is searchable.
- `bundle/base` mounts `web-fetch-http` and enables `web_fetch`; the three fork presets (`code`, `cordis`, `standard`) set `tool-web.fetch: true`, and the `code` preset disables the `workflow` tool while keeping the engine. The 2026-08-29 public-network pinning of `web-fetch-http` is what makes the default safe for the fork's multi-user Gateway deployments.
- `ui-theme` adds `corner-shape.css`, `gradient-shadow-text.css`, and per-element elevation tokens. The upstream style guards apply to fork-owned CSS: hairline `0.5px` strokes, elevated surfaces without neutral borders, and `corner-shape: round` on full-radius elements. The turn navigator preview layer sits above code banners.
- From the long-session rendering work, `buildLocationData(context, scope, previous)` reuses identical Location values, `flush()` reports whether any view was republished, `ui-slots`/`ui-renderer` gain the inject `keyedHooks` compartment, `InputBar` is memoized, and produced-file chips lay out in CSS.
- `code-runtime-python` is replaced wholesale by the upstream experimental package at `packages/experimental/code-runtime-python`, adapted to fork imports (`snapshotJsonValue` from `dsh-session`), kept `private`, and given the fork's `./invariant` companion. It requires CPython 3.10 or newer.
- Two fork regressions introduced by the alpha.2/alpha.3 sync are restored: the `loadLiveSnapshot` `!state.materialized` guard and the `list-children` seq gate with `origin`/`agentPreset` lifecycle witness keys.

The code deliberately retains these CoHarness decisions:

- The per-record projection cache layout and therefore alpha.5's `compatibleVersions`/`invalidRecords`/`backupRecord` fix are not adopted; the fork's whole-medium version 3 cache stays. The cache identity adopts optional lineage fields (`isSeeded`, `inheritedEventCount`) without a medium version bump, so existing rows of unseeded sessions remain readable and seeded sessions refold, which covers the same upgrade risk inside the fork's architecture.
- The invariant companion removal (#3367) is deferred to a separate pull request; every package, including the new experimental Python package, keeps its `./invariant` export.
- `ui-trajectory` resident pagination, the composer seat ownership migration (`conversation.input.*`/`conversation.composer.dock` moving under `composer.bar` and dropping `owner: InputZone`), and `ChatNodeStore` per-node observable sources are not adopted; the fork keeps its server-side history window, three-seat `InputBar`, and plugin-visible slot ownership.
- Upstream shared utility packages (`dsh-util-values`, `dsh-util-time`), Remote controllers, `RemoteError`, and focused `ui-chat`/`ui-session` packages remain unadopted; imports map to `dsh-session` and `dsh-llm` equivalents.
- Upstream tests for behaviors the fork removed on purpose (route pricing, request `series`, turn rail, registry `hydrate`, `titleInput`, runtime brands) are not recovered.
- The DSH release family carries `0.1.2-alpha.5.coharness.1` for the `dsh-v0.1.2-alpha.5` code baseline, tag `dsh-v0.1.2-alpha.5.coharness.1`; `apps/android-shell`, vendored, and native families keep their own version lines.

## Verification

`typecheck`, `lint`, `doc-sync` (28 leaves), `hygiene`, and `release:verify --family dsh` (247 members at `0.1.2-alpha.5.coharness.1`) pass on the source and artifact planes. The focused Vitest run over the 115 package directories with source or test changes passes 604 files and 10,186 tests; the experimental Python runtime passes 283 tests with 2 skipped under CPython 3.12. All 11 catalog and graph generators exit 0 and their reviewed Chinese counterparts are ported, translation pairing records 1,162 consistent pairs, and the keyless ACP suite replays 93 of 93 scenarios after the `send_message` schema refresh; the `subagent-continuable` transcript is re-authored so the child's two messages exercise both Steer paths (a settled child cold-resumes into its own turn, a running child claims the next message at its step boundary) and the failed durability checkpoint still settles as the parent's own later turn. The headless suite replays 16 of 17 under concurrency 5, with the product-profile model-failure smoke passing serially inside its 30 s subprocess deadline. The root plan records the exact commands. Windows native lanes, real DeepSeek API calls, assembled browser snapshots, the `pg`-backed Gateway snapshot, and production Gateway timing remain external evidence.

## Alternatives considered

**Port release-note items by hand as in alpha.2/alpha.3.** Rejected because the alpha.4 changes are protocol-wide: the brands, storage metadata, and read API touch several hundred files, and a hand port would leave fork-owned backends on the old types. The three-way merge carries every upstream hunk and leaves only genuine overlaps for human resolution.

**Remove `Session.events` as upstream did.** Rejected because `dsh-model-governance`, `dsh-directory-guard`, and Gateway code outside this repository read it. A `@deprecated` getter over the cached snapshot costs nothing and gives those consumers a migration window.

**Change the Gateway wire header to `isSeeded`/`inheritedEventCount`.** Rejected because the Gateway schema is the authority and is released separately; mapping at the persistence provider keeps the wire stable and confines the change to one package.

**Adopt the per-record projection cache layout to take the alpha.5 fix.** Rejected for this round because the fork never adopted per-record storage and the whole-medium layout has no cross-version read hazard once lineage fields are optional. Adoption remains a separate decision.

**Remove invariant companions in the same pull request.** Rejected because #3367 touches about 1,400 files with no product change and overlaps the coverage worktree; a separate pull request keeps this sync reviewable.

**Keep `web_fetch` disabled.** Rejected because the original reason, an unpinned fetch provider in multi-user deployments, was removed by public-network pinning on 2026-08-29, and upstream presets have enabled fetch since alpha.1.

**Adopt `ui-trajectory` resident pagination and the composer seat migration.** Rejected because the fork already has a server-side history window and its own virtualization, and `owner: InputZone` is a plugin-visible contract; the memoization benefit of the seat migration disappears once `InputBar` must subscribe to the whole session snapshot.

## Consequences

The fork now speaks the alpha.5 session protocol end to end, including through its own persistence backends and history wire, while its on-disk bytes, Gateway wire, authorization, and UI composition stay unchanged. Future upstream tags can be merged with the same three-way procedure using alpha.5 as the base. The maintained delta grows in three named places: the deprecated `events` getter, the Gateway `seedLength` mapping, and the whole-medium projection cache; each is recorded as a future decision point in the plan.
