# @deepseek-ai/dsh-session-format-v5-to-v6

English | [中文](README.zh.md)

## Summary

A pure adjacent V5 → V6 Session migration. It preserves the optional integer `sshTarget` already emitted by the fork's V5 encoder and advances the header version. Every event, sequence number, payload, surface operation, and inherited boundary keeps its value. The V6 writer makes this header field part of the acknowledged physical format.

## Use this package

The generated first-party Session format catalog imports this edge through `dsh.sessionFormatMigration` metadata. Persistence providers read V5 through the existing V5 codec and reconstruct V6 in memory for reads; an explicit write open publishes a separate V6 generation. Classification and header reads do not rewrite storage. Existing V5 generation bytes, inode, and modification time remain unchanged; their presence never permits fallback from a broken V6 generation.

V5 headers without `sshTarget` and headers carrying any positive safe-integer `sshTarget` are admitted. The V5 encoder already emitted this field, but its accepted JSONL type declaration and reader whitelist omitted it. Non-positive, non-integer, or non-number `sshTarget` values, unknown header fields, and future versions are refused.

## Implementation

The V6 codec delegates event framing and validation to the existing V5 codec. The migration forwards each event unchanged and observes the inherited-cut marker without collecting another artifact copy. Header-only migration changes only `version`; whole-artifact validation applies the V5 event rules under the V6 version marker.

No runtime invariant companion is published: this pure library has no registrations or independently mutable state to compare. Its codec and migration behavior is exercised by direct conversion tests and the JSONL provider's immutable-generation tests.

## Model Experience

### Historical restoration

#### What the model sees

Existing event content is preserved, including every recorded model input and output. The optional `sshTarget` header field does not enter model requests.

#### Token effect

None. The migration changes only the header version marker and never rewrites, summarizes, or drops event payloads.

#### KV Cache effect

The migration preserves historical request content and does not change prompt prefixes.

## Known Limitations and Deferred Work

- V6 is a CoHarness format successor. Upstream V3 builds cannot consume it.
- This package does not publish files, repair old generations, or infer missing SSH authorization from historical metadata.
