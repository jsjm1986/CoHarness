# Agent Note: VNC managed splice pauses both sockets across the reader-to-pump handoff

Status: implemented

English | [中文](2026-11-17-vnc-managed-splice-flowing-gap.zh.md)

## Problem

`managedHandshake`'s `ByteReader` instances attach `data` taps to the client and upstream sockets, putting both in flowing mode. The handshake resolves, the `finally` detaches the readers, and `serveStream` then installs the pump's own `data` listeners across several awaited hops (`throwIfAborted`, the upstream-residual write, `pumpRfb`). Any bytes emitted in that window hit a flowing-mode socket with zero listeners and are discarded permanently — client input and server frames alike.

The seatbelt lane's `splices a credential-managed stream and drops view-level input` hit the window twice in a row: the browser's `KEY_EVENT ‖ FB_UPDATE_REQUEST` write landed after the reader detached and before the pump attached, so the filtered request never reached upstream and the stream stayed silent. Tolerating the write with `vi.waitFor` did not help — the bytes were gone, not merely late.

## Decision

`managedHandshake` pauses both sockets in its `finally`, before the readers detach: paused sockets buffer arriving bytes instead of emitting them into the void. `serveStream` resumes both sockets immediately after `pumpRfb` attaches its listeners, so buffered bytes drain through the pump's filter. The `managedHandshake` JSDoc documents the pause as part of its contract — the caller must resume each socket after installing its listeners.

The residual path is unchanged: bytes the readers already consumed past ClientInit/ServerInit still arrive via `clientResidual`/`upstreamResidual`, which `pumpRfb` replays through the filter first, preserving arrival order ahead of the paused-socket backlog.

## Consequences

- No byte can fall between reader detach and pump attach; the splice is lossless in both directions regardless of event-loop scheduling.
- The non-managed path is untouched: without `passwordRef` no reader ever attached, the sockets never flowed, and `pumpRfb` still attaches before data.
- Failure paths need no resume: `serveStream`'s `finally` destroys the transports, so a paused socket is never leaked.
- The spec's `vi.waitFor` stays as delivery-latency tolerance; the deterministic regression asserts paused-socket bytes survive until `resume()`.

## Alternatives considered

- Keeping a `data` tap alive across the handoff and replaying it into the pump — rejected: it adds a second buffering owner beside `clientResidual` with a harder ordering story, while `pause()`/`resume()` is the stream primitive designed for listener swaps.
- Returning a `detach()` handle so the caller closes readers after attaching the pump — rejected: it inverts the close-own-what-you-open discipline and forces the pump attach inside the handshake's lifetime.
- Treating the miss as test timing — rejected by red-green evidence: with the pause removed, the deterministic spec loses the bytes every time, matching the CI signature exactly.

## Verification

- `packages/remote-desktop/remote-desktop-vnc` suite — 66/66 locally, including the new `keeps post-handshake bytes buffered on the paused sockets until the caller resumes` regression; reverting `managed.ts`'s `pause()` calls makes it lose the frame every run.
- Related: [VNC managed-handshake budget moves to Config](2026-11-17-vnc-handshake-timeout-config.md).
