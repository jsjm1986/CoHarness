# Agent Note: Generation fence for the native directory flow

Status: implemented

English | [中文](2026-09-16-native-picker-stale-settlement-fence.zh.md)

## Problem

`NativeDirectoryFlow` armed one pick per rising `open` edge but kept no request identity: an owner withdrawing `open` and re-opening while the host chooser was still on screen launched a second pick, and the first pick's late settlement still resolved through `outcome.current` — landing the stale dialog's answer on the new request's handlers. The browse counterpart carries an `openGeneration` fence; the native flow did not.

## Decision

A `generation` ref tags each launched pick. Withdrawing `open` bumps the generation, so a settlement from a retracted request is discarded; only the pick launched under the current generation may report through `outcome.current`. The `armed` and `alive` guards are unchanged — re-renders and inject-face re-registrations still keep the pending settlement, and unmount still discards it.

## Alternatives considered

**Cancel the in-flight pick when `open` is withdrawn.** Rejected: the wire carries no per-request abort, so the host dialog cannot be recalled; fencing the settlement is the only layer that can own this.

**Report the stale answer through the old handlers.** Rejected: `outcome.current` already points at the latest props, so there is no preserved old-handler channel to report through, and the retracted request must not be resolved by a later dialog's answer.

## Consequences

A close/reopen pair while the native chooser is up can no longer resolve the new request with the old dialog's path. The abandoned chooser still completes on the host display and its answer lands nowhere.

## Verification

`client-flow.client.spec.tsx` covers the regression: a pick still pending across withdraw→reopen settles to no handler, while the second pick resolves the live request.
