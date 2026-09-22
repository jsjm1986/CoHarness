# Agent Note: V5 successor for declared draft headers

Status: implemented

English | [中文](2026-09-22-v5-draft-header-successor.zh.md)

## Problem

The accepted V4 persistence record omits `draft` from the physical JSONL header while retaining it in the logical Session header. The fork’s V4 encoder delegates to the V3 encoder, which already writes the boolean field. Its narrower JSONL reader rejected that output. Correcting the reader changes the declared physical header, which the persistence rules classify as requiring a version increase even for an optional field.

## Decision

The writer advances to V5 with a [V4-to-V5 adjacent migration](../../../../packages/session/session-format-v4-to-v5/README.md). This edge changes only the header version. It retains omitted, false, and true draft states and forwards every event and inherited-cut marker unchanged. V5 header validation checks `draft` before borrowing historical event validation; that internal validation view omits `draft` because the oldest reused header validator does not know it. The caller receives the original V5 header.

The [V4 historical reference](../../../../docs/persistence-changes/historical-formats/v4.md) captures the complete declared inventory from accepted PR #218. The existing V4 acknowledgement and schema remain unchanged. The V5 successor acknowledges the header correction and the current execution-authority event additions in one ordered history. It does not infer authenticated participants for older messages; managed authorization treats missing historical proof according to its own policy.

JSONL read handles and inspection reconstruct the current artifact without publishing it. An explicit write open publishes a separate V5 generation under the existing lease and durable-publication protocol. The V4 predecessor retains its exact bytes, inode, and modification time. Unknown fields, non-boolean draft values, and future versions still fail. A predecessor remains historical evidence rather than fallback from a corrupt current generation.

## Alternatives considered

**Amend the accepted V4 snapshot.** The existing update command is for unaccepted terminal records. Replacing an accepted declaration would hide the writer/reader mismatch instead of documenting the transition.

**Exempt optional header additions from version checks.** Older JSONL readers use a closed key set and reject this field. A general exemption would also relax unrelated header and envelope changes.

**Rewrite existing V4 files.** This would break immutable-generation guarantees. The existing adjacent publication protocol already separates conversion from mutation of the source.

## Consequences

The new codec shares V4 event framing and validation instead of duplicating the event vocabulary. Provider and SDK expectations advance only the current version marker; historical fixtures keep their source versions. Upstream V3 builds cannot consume the fork’s V5 format, and the release-status record is not advanced before publication.

## Testing

Converter and catalog tests cover optional draft states, identity event forwarding, inherited cuts, malformed metadata, and future-version refusal. Real JSONL fixtures use the existing V4 encoder for both plain and separate-frame Zstandard inputs, verify read-only inspection, publish through an actual write handle, reopen cold, and compare predecessor bytes and filesystem identity. SDK expected-log updates change only eight first-line version markers; their body hashes remain unchanged and replay remains required. Local checks do not claim Windows publication or a complete release certification.
