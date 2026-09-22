# Agent Note: Envelope-driven stream producers publish on the animation-frame channel

Status: implemented

English | [中文](2026-09-22-stream-producers-publish-on-frame-cadence.zh.md)

## Problem

React 19 counts a commit as a nested update whenever the root still holds `pendingLanes & (Sync|InputContinuous|Default)` at commit end; 50 consecutive such commits throw error #185 (maximum update depth). Under React 18 the same traffic did not reach the limit.

Every mux envelope the client session stack ingests used to mark its notifier dirty on the microtask channel: `SessionManager.handleMuxEnvelope` marked the list notifier for `session/projection` and `session/jobs` frames, `recordMutation` marked it for every `engaged`/`activity`/`status`/`upsert` mutation (one per streamed event), `ProjectionValueStore.changed` marked the per-key face and the any-key channel per projection frame, and `Session.handleMuxEnvelope` marked the session notifier per `session/queue` frame. Microtask flushes interleave between React's concurrent render slices and its commit task, so during a sustained stream (per-token `contextPressure`/`contextBreakdown` projections plus one engaged mutation per content event) every render→commit window contained a pending store notification. Each commit therefore ended with subscribed work still pending, the nested-update counter incremented on every commit, and a long stream deterministically threw React #185 — surfacing in the web verification lane as failures in `chat-scroll-contract`, `trajectory-virtualization`, and `chat-long-interactions` e2e tests.

## Decision

The envelope-driven hot producers now mark their notifiers with `markFrameDirty` (one publication per animation frame) instead of `markDirty` (one per microtask), the cadence `Notifier` already designs for stream producers:

- `ProjectionValueStore.changed` — per-key faces and the any-key channel.
- `SessionManager.handleMuxEnvelope` — the `session/projection` and `session/jobs` branches.
- `SessionManager.recordMutation` — all list mutations (`engaged`, `activity`, `status`, `upsert`, `remove`), whose per-event arrival during streaming made it the hottest producer.
- `Session.handleMuxEnvelope` — the `session/queue` branch.

Frame-batched flushes arrive at frame boundaries, so the render React schedules for a pending store lane commits cleanly before the next publication; the counter resets instead of ratcheting. In environments without `requestAnimationFrame` (jsdom unit tests, Node consumers) `markFrameDirty` already falls back to microtask scheduling, so the publication contract outside the browser is unchanged.

Two adjacent violations of the same reactive contract are fixed with it:

- `SessionInputShell.publish` (`ui-conversation/input/facade.ts`) called `state.set` with a freshly composed object on every session notification. It now skips the store write unless a published member actually moved (`sameInputState` compares every member; `claim` compares by token/hint/images because the machine rebuilds it per read). Snapshot identity between changes is the uSES contract.
- `Menu` (`ui-primitives/Menu.tsx`) held `onClose` in its dismiss effect's dependency list; owners pass it inline, so the effect re-ran every render and re-dispatched `setOpenSubmenuId` inside every commit. The effect now reads the callback through a ref and depends only on `open`, matching `Modal`'s existing pattern.

## Alternatives considered

**Dedupe republished values instead of changing cadence.** Comparing incoming projections or queue rows before marking would need deep equality over arbitrary wire JSON (`preview`/`text` truncation makes shallow projection comparisons unsound for mixed content) and cannot dedupe values that legitimately advance every envelope (`contextPressure` per token). The notification storm is real traffic; the defect was its cadence, not its existence.

**Guard every component effect that can setState during commit.** Effect-site guards bound one component at a time and leave the scheduling storm intact — every store notification during the render→commit window still counted. The counts confirmed the driver was store publication cadence, not any single component.

**Route `markDirty` itself through frames globally.** Rejected: structural updates (submission echoes, pending interactions, `notifyNow` gestures) must publish inside the current task; the taxonomy "structural updates use microtask-batched `markDirty`, while visible streaming chunks use cumulative `markFrameDirty`" already owns the distinction — the fix moves the misclassified producers onto the right channel rather than redefining it.

**Move the whole client to native `useSyncExternalStore` transitions.** The bound selector hook cannot choose the scheduling lane for store notifications; React marks uSES re-renders at SyncLane itself. No binding-side change removes the commit-end pending work the counter measures.

## Consequences

- The three previously failing e2e files pass under React 19 (`chat-scroll-contract` 5/5, `trajectory-virtualization` 2/2, `chat-long-interactions` 1/1); all client unit suites pass unchanged because jsdom lacks `requestAnimationFrame` and the frame channel falls back to microtasks.
- Projection, list-mutation, jobs, and queue publications now land at most once per frame during streams; one frame (~16 ms) of extra latency applies to titles, permission flips, and queue baselines, which is the designed trade `markFrameDirty` already makes for conversation content.
- `SessionInputShell` republishes `InputState` only on member movement, so session notifications that touch nothing downstream no longer re-render the composer tree.
- `Menu`'s dismiss effect runs on the `open` edge only; every owner (not just `PermissionSelect`) inherits the fix.
- New coverage pins the cadence contract: `session/queue` frame publication in `session.client.spec.ts`, per-key/any-key frame coalescing in `projection-store.client.spec.ts`, and store-write dedup in `skeleton.client.spec.tsx`.
