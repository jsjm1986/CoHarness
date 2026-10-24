# Agent Note: Content-stable Client artifact revisions

Status: implemented

English | [中文](2026-10-24-content-stable-client-artifact-revisions.zh.md)

## Problem

Identical Client code can acquire different filesystem timestamps when rebuilt or copied into a release. A filesystem revision then changes immutable script URLs, discarding browser cache reuse and unnecessarily replacing plugins after reconnection. Entry bytes alone cannot identify a lazy chunk edit.

## Decision

The shared Client compiler appends one `dsh-client-artifact=v1` footer to every entry after all package outputs are written. Its SHA-256 digest covers length-framed, filename-ordered executable sibling filenames and exact JavaScript bytes. Debug map files stay outside executable identity. The build record rejects missing, malformed and inconsistent stamps before accepting workspace outputs.

Client Modules hashes the entry bytes it already captures, including that footer, into the row's revision. It does not discover or read lazy siblings at Host startup. The stat baseline still detects HMR candidates and skips unchanged files. Changed metadata with identical marked bytes refreshes the baseline without replacing response bodies, recomposing the graph or publishing rebuilds. Entry and lazy code changes both advance the revision.

Unmarked external artifacts retain filesystem revisions because their builders may signal lazy changes only through entry timestamps. A malformed or unsupported reserved standalone footer fails loudly. Source-map delivery and its existing prior-generation limitation remain as documented by [Client Modules](../../../../packages/client/modules/README.md#known-limitations-and-deferred-work). The [loading model](../architecture/2026-07-23-client-plugin-loading-model.md) continues to own plugin composition and lifecycle.

## Alternatives considered

- Keeping filesystem revisions loses executable equality across ordinary release copies.
- Hashing only entry code misses lazy-only edits; hashing siblings in the Host adds startup I/O for unopened viewers.
- Applying content revisions to unmarked artifacts would silently break existing external builders' invalidation signals.

## Consequences

Repeated identical output retains resource URLs; genuinely changed executable output invalidates the owning plugin. The Host adds hashing only for entry bytes it already retains, with no new cache, watcher or retention policy. Bootstrap replacement still requires a page reload, and release identity continues to prevent mixing code from different releases.

## Verification

Registry cases cover copied and touched entries, unchanged graph and response publication, true lazy-code changes and legacy revisions. The real compiler fixture checks repeated output, lazy-only edits, names, licenses, source maps and dynamic execution. Build-record cases reject missing, invalid and stale stamps. The keyless Web profile verifies browser cache reuse and preserves a staged settings edit through a real private-plugin rebuild; bootstrap failure uses a controlled transport frame without mutating shared build outputs.
