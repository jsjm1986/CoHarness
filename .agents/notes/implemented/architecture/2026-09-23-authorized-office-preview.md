# Agent Note: Office preview on the existing authorized Workspace resource

Status: implemented

English | [中文](2026-09-23-authorized-office-preview.zh.md)

## Problem

Office conversion can outlive its initiating request or return a shared cached PDF. Metadata visibility alone does not establish permission to read content. A separate file service would duplicate CoHarness Session authorization, runtime routing, and resource lifetimes, while remote FS providers cannot necessarily read a complete document in one operation.

## Decision

The upstream [Office converter](../../../../packages/document/office-to-pdf/README.md) retains its admission queue, deferred source reads, content cache, rendering limits, and engine ownership. The [bounded conversion decision](2026-09-15-bounded-office-conversion.md) owns those mechanisms. ApiProxy's existing Workspace file domain supplies the only browser conversion entry. It checks Session and file access, probes content authorization before cache lookup, and rechecks access and source identity after conversion. Requests and responses use workspace-relative paths; engine diagnostics and Host paths stay internal.

Deferred reads use version-guarded FS byte windows within the admitted capacity. This preserves the SSH provider's window limit without truncating an accepted document or weakening version checks. A cold Session header suffices; conversion neither activates an Agent nor adds Session events. Principal revocation, request cancellation, and plugin disposal invalidate pending results.

The existing Workbench file tab selects Office or PDF presentation. Upstream PDF.js worker ownership, same-version embedded assets, lazy visible-page rendering, selectable text, and font notices are adapted to that tab. The tab retains its page preference while hidden; its body releases workers and bytes. There is no second resource subscription or client PDF cache. Changed source metadata requires explicit reload; access denial hides and releases content immediately.

## Alternatives considered

- **Mount the upstream Workspace Files Remote beside ApiProxy:** would create competing authorization and resource owners.
- **Read a whole remote source before queue admission:** would bypass memory reservations and exceed transport limits.
- **Use a native browser PDF embed:** would lose the shared cancellation, selectable-text verification, and consistent missing-font presentation.

## Related decisions

The platform engine and independent kit decisions retain engine ownership. The [authorized historical review note](2026-09-23-authorized-workspace-review.md) continues to distinguish current file previews from immutable turn comparisons. This adaptation replaces only the Remote transport ownership described in the bounded conversion note.

## Consequences

Ordinary PDF reads retain the Workspace byte-window size limit. Office inputs and converted outputs use the converter's deployment limits. Runtime support requires the declared engine assets; source tests do not establish native or WASM availability. Deployment controls and release-platform acceptance remain separate obligations from the preview implementation.
