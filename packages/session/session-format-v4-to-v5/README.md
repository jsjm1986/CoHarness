# @deepseek-ai/dsh-session-format-v4-to-v5

English | [中文](README.zh.md)

## Summary

A pure adjacent V4 → V5 Session migration. It preserves the optional boolean `draft` already emitted by the fork’s V4 encoder and advances the header version. Every event, sequence number, payload, surface operation, and inherited boundary keeps its value. The V5 writer makes this header field part of the acknowledged physical format.

## Use this package

The generated first-party Session format catalog imports this edge through `dsh.sessionFormatMigration` metadata. Persistence providers read V4 through the existing V4 codec and reconstruct V5 in memory for reads; an explicit write open publishes a separate V5 generation. Classification and header reads do not rewrite storage. Existing V4 generation bytes, inode, and modification time remain unchanged; their presence never permits fallback from a broken V5 generation.

V4 headers without `draft` and headers with `draft: false` or `draft: true` are all admitted. The V4 encoder already emitted this field, but its accepted JSONL type declaration and reader whitelist omitted it. The [V4 historical reference](../../../docs/persistence-changes/historical-formats/v4.md) preserves that mismatch; this edge does not rewrite the accepted record. Non-boolean draft values, unknown header fields, and future versions are refused.

## Implementation

The V5 codec delegates event framing and validation to the existing V4 codec. The migration forwards each event unchanged and observes the inherited-cut marker without collecting another artifact copy. Header-only migration changes only `version`; whole-artifact validation applies the V4 event rules under the V5 version marker.

No runtime invariant companion is published: this pure library has no registrations or independently mutable state to compare. Its codec and migration behavior is exercised by direct conversion tests and the JSONL provider’s immutable-generation tests.

## Model Experience

None. The migration adds no model input and preserves existing event content.

## Known Limitations and Deferred Work

- V5 is a CoHarness format successor. Upstream V3 builds cannot consume it.
- This package does not publish files, repair old generations, or infer missing execution authority from historical messages.
