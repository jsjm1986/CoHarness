---
description: "Pure adjacent Session format migration chain for provider-owned v0–v2 to v3 conversion."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format

English | [中文](README.zh.md)

`dsh-session-format` is the provider-independent migration seam for Session persistence. It validates detached JSON headers and event artifacts, compiles a complete adjacent migration chain, classifies headers without reading event bodies, and converts an old generation in memory before a provider decides whether to publish a new generation. It also exposes an optional event-by-event migration stream for providers that can read legacy rows incrementally; the whole-artifact method remains the compatibility path.

The default catalog in `src/catalog-default.ts` contains the static v0 → v1 → v2 → v3 chain. First-party providers supply the released physical codecs and event normalizers through this catalog; provider code must not copy the chain or invent a parallel format version.

## Summary

`dsh-session-format` lets persistence code restore a current Session directly or compose a unique sequence of adjacent migrations while consuming physical rows once. A restore transfers caller-owned parsed values through stateful stages without intermediate artifact copies or freezing. Physical framing, compression, immutable generation naming, exclusive publication, and Cordis lifecycle behavior remain outside this library.

## Ownership and safety

- Future versions refuse before body decoding.
- Older versions migrate through every adjacent step; a missing step is an explicit unsupported-migration error.
- Inputs are detached and deeply frozen at the JSON boundary.
- Header classification never writes or repairs storage.
- Whole-artifact migration validates every adjacent target, including migrations implemented with incremental stages. Streaming stages own event validation and flush in source-to-target order; the stream does not run whole-artifact validators.

The catalog is a pure value operation. JSONL, Gateway, and SQLite adapters remain responsible for their own raw bytes, crash-tail recovery, backups, and atomic publication.

## Model Experience

### Session restoration

#### What the model sees

Nothing directly. Consumers reconstruct model history from the validated current artifact through `deriveMessages()`.

#### Token effect

Zero direct tokens.

#### KV Cache effect

No direct effect. A migration that changes current history can change the cache identity owned by request reconstruction.

## Known Limitations and Deferred Work

- The pre-v3 steps normalize the historical event vocabulary (legacy message payloads, `start`/`end` replace keys, turn-scoped surface events) while each provider retains its own physical codec and publication rules.
