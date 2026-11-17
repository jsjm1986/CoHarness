# Agent Note: RfbClientFilter frames client messages by their RFC 6143 type numbers

Status: implemented

English | [中文](2026-11-17-rfb-client-message-numbers.zh.md)

## Problem

`RfbClientFilter` mapped RFB client→server message types off by one: `FramebufferUpdateRequest` was keyed as `2` (10 bytes), `KeyEvent` as `3` (8 bytes), `PointerEvent` as `4` (6 bytes), `SetEncodings` as `1`, and `ClientCutText` as `5`, with `VIEW_ALLOWED = {0, 1, 2}`. RFC 6143 numbers these messages `3`, `4`, `5`, `2`, and `6`, and the allowed set is `{0, 2, 3}`.

A view-level browser writing `KEY_EVENT ‖ FB_UPDATE_REQUEST` in one chunk was therefore consumed as: `KeyEvent` (type 4) framed as a 6-byte `PointerEvent`, dropping the frame, then the next buffer began `00 61 ‖ 03 …` — type `0` (`SetPixelFormat`, needs 20 bytes) with only 12 buffered — so the filter returned empty output and held the real request forever. Upstream never saw the framebuffer update and the splice assertion timed out on the coverage, seatbelt, and Windows lanes.

The failure looked like a delivery race because local runs used a worktree copy of `rfb.ts` that already carried the corrected table while CI exercised the committed table. Emit-time listener snapshots and a `filter.push` spy ruled out listener ordering and showed `push` itself returning empty for the exact 18-byte input with `dropped=1`.

## Decision

Correct the constants in `rfb.ts` to RFC 6143 numbering: `FRAME_FIXED = {0:20, 3:10, 4:8, 5:6}`, variable-length `SetEncodings` at type `2`, `ClientCutText` at type `6`, and `VIEW_ALLOWED = {0, 2, 3}`. `rfb.spec.ts` updates its fixture bytes to the real wire types and adds a regression that concatenates one of every frame kind and pushes it split at every byte boundary, asserting the allowed subset comes out intact and the view-forbidden frames are counted as dropped.

## Consequences

- A dropped frame can no longer misalign the stream: `KeyEvent` consumes its full 8 bytes, so the following `FramebufferUpdateRequest` is framed correctly and forwarded.
- Mis-keyed constants previously also rejected legitimate view-level `SetEncodings` (type 2) and passed `PointerEvent` (type 5) lengths incorrectly; both now match the spec.
- The diagnosis only surfaced under coverage instrumentation because the worktree's corrected `rfb.ts` was never committed; the new byte-split spec pins the table regardless of file-copy drift.

## Alternatives considered

- Treating the miss as pump/listener timing — rejected by instrumentation: `upstreamChunk` held the exact 18-byte chunk and `upstream.write` was never called, isolating the loss inside `push`.
- Buffering residuals until a frame type validates — rejected: the wire format is self-delimiting only when the type table is right; a wrong table cannot detect its own misalignment.

## Verification

- `packages/remote-desktop/remote-desktop-vnc` suite — `rfb.spec.ts` and `managed-handshake.spec.ts` 20/20 locally; against the committed `rfb.ts` the splice test reproduces the CI signature deterministically (empty upstream, pending pump).
- Related: [VNC managed splice pauses both sockets across the reader-to-pump handoff](2026-11-17-vnc-managed-splice-flowing-gap.md).
