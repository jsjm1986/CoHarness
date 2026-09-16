# Agent Note: Floor geometry owns at-bottom in Chat scroll ownership

Status: implemented

English | [中文](2026-09-16-floor-geometry-owns-at-bottom.zh.md)

## Problem

`ChatView`'s scroll listener attributed ownership through the observed-top ledger: a delivered `scrollTop` matching `min(observedTop, floor)` was treated as a non-reader write, and `isAtBottom` then inherited `atBottomRef` unchanged. Browser-driven `scrollTop` writes — scroll anchoring during reflow, shrink clamps, compositor deliveries — never reach that ledger. Once an un-ledgered write off the floor flipped the ref to `false`, a later browser clamp landing exactly on the floor inherited the stale `false`: the reader sat at the tail while follow stayed disarmed and the back-to-bottom button remained mounted until a manual scroll. The defect surfaced as a flaky `question-composer` aria-golden failure on CI, where the answered-transcript snapshot intermittently caught the stranded button.

## Decision

`isAtBottom` is now pure geometry — `floor - scrollTop <= FOLLOW_THRESHOLD + 1` — regardless of who wrote the position. The `!movedByReader && isAtBottom` early path re-arms ownership when the ref was `false`: it clears the paging anchor and the saved reader position exactly as a reader scroll back to the bottom does, then re-runs `toBottom`. The ledger still classifies reader input (deviation from `min(observedTop, floor)`), so genuine reader scrolls off the floor disarm follow exactly as before; only the at-bottom verdict stopped consulting the ref.

## Alternatives considered

**Suppress browser writes with `overflow-anchor: none` on the scrollport.** Rejected: it addresses only scroll anchoring, not shrink clamps or other compositor deliveries, and forfeits anchoring's benefit for readers parked mid-history while new content arrives.

**Keep ref-inherited `isAtBottom` and normalize the button out of the e2e golden.** Rejected: it papers over a product defect — follow permanently dead and the button stuck — rather than a snapshot artifact.

**Await the settled state in `captureStableAria`.** Rejected as the fix: the captured state was genuinely wrong (the button was mounted and would not unmount), so waiting only makes the wrong state deterministic.

## Consequences

Any floor-landed position re-pins follow, including browser clamps and anchored writes, so the back-to-bottom button can no longer strand itself. Reader scrolls still disarm follow, save the position for later restore, and mount the button; clicking it or scrolling to the bottom re-pins through the same path. The `movedByReader` classification is unchanged, so compositor-delivered positions ahead of their events keep attributing to the reader.

## Verification

`chat-view.client.spec.tsx` covers the regression: an un-ledgered write off the floor disarms follow and mounts the button, a shrink clamp landing on the floor re-pins and clears the saved position, and streaming growth then reaches the tail. The existing stream-finalization clamp, compositor-delivered, and reader-scroll cases continue to pin the surrounding contract; `apps/web/tests/question-composer.e2e.ts` is the canary that surfaced the defect.
