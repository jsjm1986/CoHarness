---
kind: upgrade-guide
description: "New Session preparation protects the originating composer from sending to the old conversation."
---

# Input stays with its conversation during New Session preparation

English | [中文](guide.zh.md)

## Change

New Session preparation temporarily holds the originating composer and displays “Opening the new conversation…”. Its draft and running task remain available; Stop remains usable. Successful preparation opens the new Session, and failure restores input in the original conversation. Other panes and browser tabs keep their own input.

## Migration

Custom `ISessions` and `SessionsPort` implementations accept `beginNavigation({ blockInputFor: sessionId })`, publish the optional `navigationBlockedSessionId` in their Session-list projection, and implement `finishNavigation(signal)`. Completion releases only the hold belonging to that original signal. Navigation consumers finish their intent in `finally`; synchronous selection or a newer intent supersedes the previous hold. Omitting `blockInputFor` leaves input available.

Rebuild custom client assemblies and reload their pages. No database or Session-log migration is required. See the [client navigation reference](../../../../packages/client/runtime/README.md).
