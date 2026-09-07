---
description: "Pure adjacent Session format migration chain for provider-owned v0/v1 to v2 conversion."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format

English | [中文](README.zh.md)

`dsh-session-format` is the provider-independent migration seam for Session persistence. It validates detached JSON headers and event artifacts, compiles a complete adjacent migration chain, classifies headers without reading event bodies, and converts an old generation in memory before a provider decides whether to publish a new generation.

The default catalog in `src/catalog-default.ts` contains the static v0 → v1 → v2 chain. First-party providers supply the released physical codecs and event normalizers through this catalog; provider code must not copy the chain or invent a parallel format version.

## Ownership and safety

- Future versions refuse before body decoding.
- Older versions migrate through every adjacent step; a missing step is an explicit unsupported-migration error.
- Inputs are detached and deeply frozen at the JSON boundary.
- Header classification never writes or repairs storage.

The catalog is a pure value operation. JSONL, Gateway, and SQLite adapters remain responsible for their own raw bytes, crash-tail recovery, backups, and atomic publication.

## Model Experience

None, as this package only validates and migrates durable Session data; provider and prompt consumers own every model-visible effect.

#### KV Cache effect

No direct invalidation: the package does not contribute request tokens or mutate a model request prefix.

## Known Limitations and Deferred Work

- The v0/v1 steps preserve the supported historical event vocabulary while each provider retains its own physical codec and publication rules.
