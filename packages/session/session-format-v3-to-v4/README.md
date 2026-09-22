---
description: "The CoHarness V3-to-V4 Session conversion: fold streamed assistant chunks into settled assistant events, plus native V4 admission."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v3-to-v4

English | [中文](README.zh.md)

## Summary

Restore released V3 Sessions as V4 by folding `assistant/chunk` streams into their settling `assistant/message` or `assistant/attempt` events. This page is the single specification for this adjacent edge: what it transforms, preserves, and refuses, followed separately by native V4 admission. The library remaps dense event sequences and every audited sequence reference; persistence consumes it through the static catalog and never reads files here.

## Table of Contents

- [Use this package](#use-this-package)
- [V3-to-V4 specification](#v3-to-v4-specification)
- [Native V4 admission](#native-v4-admission)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use the [catalog](../session-format-catalog/README.md) to restore a Session. Direct imports serve catalog assembly and tests; this library has no Cordis mount configuration. The [public exports](src/index.ts) provide the migration declaration, released V3 source codec, V4 target codec, target header validator, and target restorer.

-----

<a id="v3-to-v4-specification"></a>
## V3-to-V4 specification

The logical header changes `version: 3` to `version: 4`; every other header field is retained. Source events must be dense from zero.

Each `assistant/chunk` is buffered into its `(turn, step)` attempt group. A settling `assistant/message` or `assistant/attempt` in the same group emits the settlement with its own `data.stream` when present, otherwise the accumulated chunk stream; buffered chunks never appear in the target. A group left open by a closing `turn/end`, `step/end`, `llm/retry`, or `llm/retry-started`, or still open at `finish()`, emits a synthesized `assistant/attempt` carrying the accumulated stream, then replays the events interleaved after the last chunk in source order.

Folding changes event count, so every emitted event receives a new dense sequence and every audited same-artifact sequence reference is remapped: `sourceEventSeqs`, `surfaceOp` replace `startSeq`/`endSeq`, `command/done.data.sourceEventSeq`, `compaction/summary` and `compaction/prune` `shadowedRange`/`shadowedSeqs`, and `session/title`/`session/title-llm-request` `messageSeqs`. Settlements with an embedded stream cannot carry `sourceEventSeqs` and are refused if one is present.

For a seeded Session, the `session/end-seed` marker states the inherited cut: the self-describing `data.inherited: true` form or a bare marker exactly at the header's seed count. The cut must not split a live chunk group. A seeded source without its marker is refused as corrupt.

<a id="native-v4-admission"></a>
## Native V4 admission

The V4 codec reuses V3 physical framing. Native V4 reads refuse `assistant/chunk` rows and events: V4 stores only settled assistant events. Header validation requires `version: 4` plus every V3 header rule; artifact restoration applies the V3 relationship, surface, and vocabulary checks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [stage](src/migration.ts) owns the per-artifact source-to-target sequence map, the pending attempt group, and the inherited-cut state. Compact runs expand incrementally. The [codec](src/codec.ts) wraps the frozen V3 codec with the chunk refusal; the [restorer](src/validation.ts) delegates to V3 validation on a version-adjusted artifact. No runtime invariant companion is published because this library owns no independently observable registrations or state replicas.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Historical restoration

#### What the model sees

Each historical request retains its settled assistant output; streamed chunks reappear as the `stream` of their settling event or of a synthesized `assistant/attempt`.

#### Token effect

The edge removes chunk rows without adding model-visible text.

#### KV Cache effect

The edge preserves historical request meaning; it does not guarantee provider cache hits or byte-identical V4 recordings.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **CoHarness-only edge** — upstream released V3 as the current format; V4 exists only in this fork. Downstream artifacts cannot be reopened by upstream builds.
