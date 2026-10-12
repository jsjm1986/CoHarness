# Agent Note: Durable-path safety fixes — spill publish, attachment carriers, V3 restart repair

Status: implemented

English | [中文](2026-10-12-durable-path-safety-fixes.zh.md)

## Problem

Three independent defects on durable-output paths, all confirmed by upstream source comparison:

1. `OutputCollector` published `spillFile` before the exclusive `openSync` succeeded, so a failed open let `discardSpill` unlink a path the process never created (including a planted EEXIST entry); a throwing `onFailure` reporter escaped the stream listener as an uncaught exception.
2. The live attachment route (`api-proxy.ts` `imageInEvent`) and the export collector (`session-export.ts` `collectEventAttachmentRefs`) scanned `content`/`message`/`inserted`/`stream` fields on every event payload, so opaque or ignorable plugin events could trigger attachment-store reads.
3. The CoHarness V3→V4 stage neither repaired interrupted turns nor remapped `image/offload` target seqs, so a V3 restart produced a V4 log missing a `turn/end` and offload events kept pointing at pre-renumbering coordinates.

## Decision

1. Port upstream `cafb9b93b4b`: publish `spillFile` only after `openSync` succeeds, contain a throwing reporter to a stderr line, and share the owner log line through the exported `logSpillFailure(logger, owner)` used by `subprocess-local` and the SSH helper.
2. Port upstream `0c44e5461db`: scan only declared first-party carriers — `content` on `user/message`/`tool/ptc-dispatch`, `message.content` on `system|developer|tool/result|team/message/queued`, `inserted[].content` on `agent/inbox/spliced`, `summary`/`rawOutput` on `compaction/summary`, and completed `block-end` stream records on `assistant/message`/`assistant/attempt` — plus our retained `assistant/chunk` carrier for unversioned artifacts. Nested `tool-result` descent is dropped in both places.
3. Adapt upstream `ad83cce36ac` onto the CoHarness folding stage: `observeRestart` synthesizes `turn/end` `{ reason: { kind: 'interrupted' } }` when a `next-turn` inbox splice is followed by `turn/start` for `turn + 1` outside an open step; `remapDataReferences` gains an `image/offload` `targets[].seq` case validated through `mappingNumber`.

## Alternatives considered

**Keep the arbitrary-payload scan.** Rejected: durable plugin events are an unbounded input space, and attachment reads have store cost; upstream fixed the same surface.

**Skip the restart repair because CoHarness migrates v3 only transitively.** Rejected: the v3→v4 stage is still the admission point for released v3 artifacts, and a missing `turn/end` fails strict V4 validation downstream exactly as upstream documented.

## Consequences

A failed spill open can no longer remove foreign paths; owner reporters cannot take down collection. Attachment discovery reads only declared fields, so plugin events without a carrier case are ignored wholesale. V3 restarts migrate into strictly valid V4 logs with `interrupted` turn ends, and `image/offload` coordinates stay correct across inserted boundaries. Events that previously resolved attachments through `context/inserted` or nested `tool-result` blocks no longer do — those shapes were never declared carriers.

## Verification

`subprocess-local` 359 tests (EEXIST never-unlinks, throwing reporter contained, bare-caller stderr, owner logger line), `session-format-v3-to-v4` 43 tests (restart repair, refusal matrix, cross-boundary remapping, offload validation), `apiproxy` session-export 43 tests (declared carriers exported, opaque payloads untouched); all four packages typecheck clean.

## Related

- [DeepSeek request-extension resilience](2026-10-12-deepseek-request-extension-resilience.md), [Python PTC shared sandbox policy](2026-10-12-python-ptc-shared-sandbox-policy.md) — the same alpha.2 alignment campaign.
- Upstream commits: `cafb9b93b4b`, `0c44e5461db`, `ad83cce36ac`.
