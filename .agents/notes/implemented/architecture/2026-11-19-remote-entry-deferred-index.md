# Agent Note: Deferred remote Runtime entry

Status: implemented

English | [中文](2026-11-19-remote-entry-deferred-index.zh.md)

## Problem

Direct navigation from the primary Gateway to a remote Runtime waits for that Runtime's rendered HTML before fetching shared browser assets. A slow node leaves the browser on its navigation screen while the user could already be writing unsent input.

## Decision

The primary serves its release shell after a fresh account catalog check for the exact allocation. The selected computer supplies the index injection rows through the existing authenticated index gate. The browser verifies the returned account and Runtime before applying those rows. Raw HTML taps use the same native index as direct entry.

The boot page accepts text owned by one document. Only the original saved Session can adopt that text after the account, Runtime and computer are verified and the Session's draft writer is ready. An unavailable saved Session leaves the text available in the original document. Prepared history for the exact saved Session shares the initial Session window. The ordinary catalog still decides whether that Session can become current.

## Alternatives considered

Preloading browser assets from a delayed response leaves the first visible screen dependent on the remote node. A local draft with a verified owner gives the user an earlier point to start writing.

## Consequences

Static shell delivery is local to the authenticated entry. The browser still loads the selected Runtime's plugin graph and required connection state before mounting the complete application. Model onboarding waits for the workspace baseline on a remote landing. The plugin approval inventory still reconnects using the live connection events.

## Verification

The built browser scenario holds the remote bootstrap for two tabs, types different text in each, and checks that only the original account and Runtime Session receive the draft. It observes no prompt submission or unrelated Runtime requests during the hold.
