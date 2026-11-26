# Agent Note: Deferred remote Runtime entry

Status: implemented

English | [中文](2026-11-19-remote-entry-deferred-index.zh.md)

## Problem

Direct navigation from the primary Gateway to a remote Runtime waits for that Runtime's rendered HTML before fetching shared browser assets. A slow node leaves the browser on its navigation screen while the user could already be writing unsent input.

## Decision

The primary serves its release shell after a fresh account catalog check for the exact allocation. The selected computer supplies the index injection rows through the existing authenticated index gate. The browser verifies the returned account and Runtime before applying those rows. Raw HTML taps use the same native index as direct entry.

The boot page accepts text owned by one document. Loader updates and required plugin failures preserve the focused input and its full-workspace link. Following it opens a separate document bound to the same account, computer and allocation. Only the original saved Session can adopt that text after the account, Runtime and computer are verified and the Session's draft writer is ready. An unavailable saved Session leaves the text available in the original document. Prepared history for the exact saved Session shares the initial Session window. The ordinary catalog still decides whether that Session can become current.

A structured response asking for the full index continues normal document navigation and does not report a plugin failure. Only an empty draft allows the full index to replace the boot page. With text present, the original editor remains available and the full-workspace link opens the same selection in a separate tab so opening the full page never discards the draft.

## Alternatives considered

Preloading browser assets from a delayed response leaves the first visible screen dependent on the remote node. A local draft with a verified owner gives the user an earlier point to start writing.

## Consequences

Static shell delivery is local to the authenticated entry. The shell sends `x-dsh-bootstrap-preload: 1` so the owning Gateway keeps application `script-preload` rows. With the queue installed, it starts one same-origin, revision-pinned application script at low priority alongside the high-priority bootstrap sequence. Protected scripts use `private, no-store`, so a preload hint alone cannot guarantee reuse. The module system receives the actual outcome: an executed batch uses single URLs only for missing factories, and a failed download consumes the first batch attempt. A failed revisioned bootstrap download gets one retry at its original URL. Older shells without the header receive bounded structured boot responses without application preload rows. The complete application waits for required plugins and connection state. Model onboarding waits for the workspace baseline on a remote landing. The plugin approval inventory reconnects using the live connection events.

## Verification

The built browser scenario holds the remote bootstrap for two tabs and types different text in each. One tab receives a 503 for the bootstrap download, recovers on retry, and overlaps exactly one application batch without duplicating it after module-system creation. The application recovery scenario observes only one single-resource request after dropping one factory, and one ordinary batch retry before single-resource requests when the early download fails. Only the original account and Runtime Session receive each draft. The test observes no prompt submission or unrelated Runtime requests during the hold.
