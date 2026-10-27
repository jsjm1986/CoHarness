# Agent Note: Content-stable Client artifact revisions

Status: implemented

English | [中文](2026-10-24-content-stable-client-artifact-revisions.zh.md)

## Problem

Identical Client code can acquire different filesystem timestamps when rebuilt or copied into a release. A filesystem revision then changes immutable script URLs, discarding browser cache reuse and unnecessarily replacing plugins after reconnection. Entry bytes alone cannot identify a lazy chunk edit. Giving every lazy chunk its owner's revision also invalidates unchanged viewers when unrelated entry code changes.

## Decision

The shared Client compiler appends one `dsh-client-artifact=v1` footer to every entry after all package outputs are written. Its SHA-256 digest covers length-framed, filename-ordered executable sibling filenames and exact JavaScript bytes. Debug map files stay outside executable identity. The build record rejects missing, malformed and inconsistent stamps before accepting workspace outputs.

A preceding versioned `dsh-client-chunks` table records each chunk's executable digest without standalone generated debug trailer lines. Directive-like strings, block comments and executable line separators remain executable bytes; both digesting and HTTP assembly preserve them. Tail recognition excludes whitespace, quotes, backticks, backslashes and asterisks from the generated URL, so it cannot consume the closing syntax of a multiline literal or comment. Unrecognized tails remain verbatim. The Host projects the captured table into optional graph-row metadata and verifies matching executable bytes on the first lazy read. Chunk scripts and map trailers use the chunk revision, while the current owner-revision URL remains accepted for legacy Clients. Legacy Hosts and artifacts without a table keep owner-revision URLs. Unknown, stale or non-exact URLs are refused, and an incomplete disk rewrite cannot publish new executable bytes under an old immutable URL. Failed chunk bodies evict only the same response plan still held by the registry; the next explicit request can read restored bytes, while successful responses remain immutable and no automatic retry runs.

Client Modules hashes the entry bytes it already captures, including that footer, into the row's revision. It does not discover or read lazy siblings at Host startup. The stat baseline still detects HMR candidates and skips unchanged files. Changed metadata with identical marked bytes refreshes the baseline without replacing response bodies, recomposing the graph or publishing rebuilds. Entry and lazy code changes both advance the revision.

Owner revisions still govern factory replacement. A chunk table is used only with its matching owner revision; rebuilt-only frames withdraw old chunk metadata until a full graph supplies current identities. One transport settlement owns stale-generation cleanup for a chunk, and every waiter awaits it before reading factories or exports. Old caller continuations cannot delete replacements after another waiter resumes. The next generation may execute the same cached chunk URL again to bind its factory to the current owner.

Unmarked external artifacts retain filesystem revisions because their builders may signal lazy changes only through entry timestamps. A malformed or unsupported reserved standalone footer fails loudly. Source-map delivery and its existing prior-generation limitation remain as documented by [Client Modules](../../../../packages/client/modules/README.md#known-limitations-and-deferred-work). The [loading model](../architecture/2026-07-23-client-plugin-loading-model.md) continues to own plugin composition and lifecycle.

## Alternatives considered

- Keeping filesystem revisions loses executable equality across ordinary release copies.
- Hashing only entry code misses lazy-only edits; hashing siblings in the Host adds startup I/O for unopened viewers.
- Applying content revisions to unmarked artifacts would silently break existing external builders' invalidation signals.
- Keeping owner revisions on unchanged chunks discards reusable viewer downloads. Hashing debug maps into entry or chunk revisions makes diagnostic-only changes invalidate executable resources.

## Consequences

Repeated identical output retains resource URLs; genuinely changed executable output invalidates the owning plugin. Unchanged chunks retain their URLs across owner-only edits. The Host hashes entry and requested chunk bytes it already reads, with no eager sibling scan or additional artifact generation retained. Concurrent generations wait for the existing chunk transport to settle before accepting another factory. Bootstrap replacement still requires a page reload, and release identity continues to prevent mixing code from different releases.

## Verification

Registry cases cover copied and touched entries, unchanged graph and response publication, true lazy-code changes, legacy revisions, exact chunk URLs, deferred file reads and refusal of mismatched disk bytes. Loader barriers cover unchanged-URL invalidation with multiple old and current waiters, delayed changed-code arrivals and rebuilt-only metadata withdrawal. The real compiler fixture checks repeated output, lazy-only edits, names, licenses, source maps and dynamic execution. Build-record cases reject missing, invalid and stale stamps. The keyless Web profile verifies browser cache reuse and preserves a staged settings edit through a real private-plugin rebuild; bootstrap failure uses a controlled transport frame without mutating shared build outputs.
